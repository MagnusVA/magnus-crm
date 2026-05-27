# Billing Ops Review Brainstorm

> Date: 2026-05-26
> Status: Brainstorm / pre-plan
> Context: Tenant-admin billing operators need a focused way to review payment records, reconstruct the attribution chain, and copy clean data into an external billing platform. This document is intentionally not an implementation plan yet.

## One-Line Recommendation

Build a dedicated **Billing Ops** queue anchored on `paymentRecords`, enriched with customer, payment registrant, phone closer, DM closer, and Slack opener context. For MVP, treat `paymentRecords.status === "verified"` as "billing reviewed" if product semantics allow it; otherwise add dedicated billing review fields with a migration strategy.

## Problem

Billing operators need a source-of-truth work queue for payments. The CRM does not need to become the billing platform. It needs to make it easy for a specialized tenant admin to:

- See every newly recorded payment.
- Understand who paid and what they bought.
- See who entered the payment in CRM.
- See the phone closer credited for the payment.
- See the external DM setter/closer attribution from the booking link.
- See the Slack opener who used `/qualify-lead`.
- Review one payment at a time.
- Mark each payment as reviewed, stamping the reviewer for reporting.
- Copy or export the normalized data into another billing platform.

This is an operational review workflow, not a revenue dashboard.

## Existing Data We Can Use

### Payment Record

`paymentRecords` is the right queue source.

Relevant fields:

| Need | Current field |
| --- | --- |
| Tenant isolation | `tenantId` |
| Payment amount | `amountMinor`, `currency` |
| Payment program | `programId`, `programName` |
| Payment type | `paymentType` |
| Payment proof/reference | `proofFileId`, `referenceCode`, `note` |
| Payment effective date | `recordedAt` |
| User who entered payment | `recordedByUserId` |
| Phone closer credited | `attributedCloserId` |
| Review-ish state | `status`, `verifiedAt`, `verifiedByUserId`, `statusChangedAt` |
| Customer link | `customerId` |
| Opportunity link | `opportunityId`, `originatingOpportunityId` |
| Meeting link | `meetingId` |
| Payment origin | `origin`, `contextType`, `commissionable` |

Existing indexes already support the main queue:

```text
by_tenantId_and_status_and_recordedAt
by_tenantId_and_recordedAt
by_customerId_and_recordedAt
by_opportunityId
```

This means the default queue can be efficient without a new read model:

```text
tenantId + status=recorded + recordedAt desc
```

### Customer

`customers` gives the billing operator the actual buyer/customer context.

Relevant fields:

| Need | Current field |
| --- | --- |
| Customer name | `fullName` |
| Email | `email` |
| Phone | `phone` |
| Source lead | `leadId` |
| Winning opportunity | `winningOpportunityId` |
| Winning meeting | `winningMeetingId` |
| Program at conversion | `programId`, `programName` |
| Converted by | `convertedByUserId` |

For commissionable payments, `customerId` should usually be patched after conversion. For older or edge rows, the fallback is:

```text
payment.opportunityId
  -> opportunity.leadId
  -> customers.by_tenantId_and_leadId
```

For post-conversion payments, `customerId` is direct and `originatingOpportunityId` points back to the original winning opportunity.

### Phone Closer And Payment Registrant

There are two separate people to show:

| Label | Field | Meaning |
| --- | --- | --- |
| Entered by | `paymentRecords.recordedByUserId` | User who registered the payment in CRM. Could be closer or admin. |
| Phone closer | `paymentRecords.attributedCloserId` | Closer credited for commissionable revenue. |

This distinction matters because admins can log a payment on behalf of a closer. In that case:

```text
recordedByUserId = admin
attributedCloserId = credited closer
origin = admin_meeting / admin_reminder / admin_side_deal
```

### Meeting And DM Attribution

The external DM attribution chain is already stored on meetings and opportunities:

| Need | Preferred source | Fallback |
| --- | --- | --- |
| Meeting that led to payment | `payment.meetingId` | `customer.winningMeetingId`, `opportunity.firstMeetingId`, `opportunity.latestMeetingId` |
| Phone closer on meeting | `meeting.assignedCloserId` | `payment.attributedCloserId`, `opportunity.assignedCloserId` |
| DM team | `meeting.attributionTeamId` | `opportunity.attributionTeamId` |
| DM setter/closer | `meeting.dmCloserId` | `opportunity.dmCloserId` |
| Raw UTM source/medium | `meeting.utmParams` | `opportunity.utmParams` |
| Booked program | `meeting.bookingProgramName` | `opportunity.firstBookingProgramName` |
| Sold program | `payment.programName` | `opportunity.soldProgramName` |

The current attribution helper already resolves most of this:

```text
buildOpportunityAttributionPayload(ctx, opportunity, { meeting })
```

That helper returns Slack qualification, booked program, sold program, DM team/closer, phone closer, and timeline. Billing Ops should reuse or extract similar enrichment rather than duplicating logic in every query.

### Slack Opener

The Slack opener is the person who used `/qualify-lead`. Current data exists in two places:

| Source | Use |
| --- | --- |
| `opportunity.qualifiedBy.slackUserId` | Stable shortcut for Slack-qualified opportunities. |
| `slackQualificationEvents` | Ledger of `/qualify-lead` submissions, including duplicate and already-booked events. |
| `slackUsers` | Display name directory for Slack IDs. |

Recommended resolution:

1. If `opportunity.qualifiedBy` exists, use that as the primary opener.
2. Else query latest linked `slackQualificationEvents` by `tenantId + opportunityId`.
3. Resolve display label through `slackUsers.by_tenantId_and_slackUserId`.
4. Fall back to raw Slack user ID if the display snapshot is missing.

Open detail: if multiple Slack qualification events link to the same opportunity, Billing Ops probably wants the original opener for attribution, not the latest duplicate event. The current `opportunity.qualifiedBy` field is the safest shortcut for that.

## Proposed Billing Ops Surface

### Route Shape

```text
/workspace/billing
```

Potential tabs:

| Tab | Purpose |
| --- | --- |
| `Needs review` | Default queue: newly recorded payments. |
| `Reviewed` | Payments already checked by billing. |
| `Disputed` | Payments marked disputed. |
| `Exports` | Optional later: CSV or period export for external billing platform. |

The first version can be one page with filters instead of tabs.

### Default Queue

Default query:

```text
paymentRecords
  withIndex("by_tenantId_and_status_and_recordedAt")
  tenantId = current tenant
  status = "recorded"
  order desc
  paginate
```

Each row should show:

| Column | Data |
| --- | --- |
| Paid at | `payment.recordedAt` |
| Customer | Customer name, email, phone |
| Amount | `amountMinor`, `currency` |
| Payment program | `payment.programName` |
| Payment type | `payment.paymentType` |
| Entered by | `recordedByUserId` display name |
| Phone closer | `attributedCloserId` display name |
| DM attribution | DM team + DM closer, or raw UTM fallback |
| Slack opener | Slack display label or raw Slack ID |
| Status | recorded / reviewed / disputed |

### Detail / Review Panel

The operator should be able to go one by one. A split view is probably better than opening full detail pages:

```text
left: queue
right: selected payment review panel
```

The review panel should include:

- Payment summary.
- Customer identifiers.
- Payment proof link or image preview if available.
- Reference code and note.
- Payment origin label.
- Opportunity and meeting links.
- Phone closer and registrant.
- DM team and DM closer.
- Slack opener.
- Raw UTM source/medium/campaign as diagnostic fallback.
- Copyable "external billing payload" fields.
- Controlled correction action for payment amount/details when billing finds a mistake.
- Primary action: `Mark reviewed`.
- Secondary action: `Mark disputed` or `Needs info` if product wants that state.

### Correct Payment

Billing operators should be able to correct a payment when the CRM record is wrong, especially an incorrect amount. This should be a deliberate correction workflow, not inline silent editing.

Recommended editable fields for MVP:

| Field | Editable? | Notes |
| --- | --- | --- |
| Amount | Yes | Primary use case. Convert through existing money helpers and store as `amountMinor`. |
| Currency | Maybe | Safer to allow only if multi-currency mistakes are real. Currency changes affect reporting interpretation. |
| Payment type | Yes | `pif`, `split`, `monthly`, `deposit`; affects revenue bucket reporting. |
| Payment program | Yes | Changes sold-program/reporting dimensions and possibly customer-facing context. |
| Reference code | Yes | Low-risk billing/admin metadata. |
| Note | Yes | Low-risk audit context. |
| Proof file | Maybe | Useful if wrong screenshot was uploaded, but storage replacement needs explicit UX. |
| Customer/opportunity/meeting links | Not MVP | Higher-risk because this changes attribution chain and customer conversion context. Handle as a separate repair flow. |
| Phone closer attribution | Not MVP | This impacts commission attribution. Handle as an admin attribution correction flow, not casual billing edit. |

Correction mutation requirements:

- Require `tenant_master`, `tenant_admin`, or future `billing_admin`.
- Load the existing payment and verify `tenantId`.
- Validate amount is positive and finite.
- Snapshot the old payment before patching.
- Patch only explicitly editable fields.
- Call `replacePaymentAggregate(ctx, oldPayment, paymentId)` after patching.
- Apply tenant stats delta for changed amount/type/commissionability bucket where needed.
- Refresh customer payment summary if `customerId` exists.
- Refresh sold-program caches if `programId` or `programName` changes and the payment is opportunity-linked.
- Emit a `domainEvents` entry such as `payment.corrected`.
- Require a correction reason for amount, program, currency, or payment type changes.

The core amount-only patch shape is:

```ts
const oldPayment = payment;
await ctx.db.patch(paymentId, {
  amountMinor: correctedAmountMinor,
  statusChangedAt: now,
});
await replacePaymentAggregate(ctx, oldPayment, paymentId);
await applyPaymentStatsDelta(ctx, tenantId, {
  commissionable: oldPayment.commissionable,
  paymentType: oldPayment.paymentType,
  amountMinorDelta: correctedAmountMinor - oldPayment.amountMinor,
});
if (oldPayment.customerId) {
  await syncCustomerPaymentSummary(ctx, oldPayment.customerId);
}
```

If payment type also changes, the stats delta should remove the old bucket and add the new bucket, not only apply an amount delta to the old type:

```text
old type: amountMinorDelta = -oldAmountMinor
new type: amountMinorDelta = +newAmountMinor
```

Open implementation detail: if `status === "verified"` already means billing reviewed, editing a reviewed payment should either:

1. Keep it reviewed but emit a correction event; or
2. Move it back to `recorded` / unreviewed so a second billing review is required.

For financial accuracy, the safer default is to move corrected reviewed payments back to the review queue unless the correction only changes low-risk metadata like reference code or note.

### Mark Reviewed

If we reuse existing payment status:

```ts
await ctx.db.patch(paymentId, {
  status: "verified",
  verifiedAt: now,
  verifiedByUserId: userId,
  statusChangedAt: now,
});
```

Also emit:

```text
domainEvents:
  entityType = "payment"
  eventType = "payment.verified"
  actorUserId = reviewer
  source = "admin"
```

The UI can then automatically advance to the next row.

## Product Semantics: Reviewed vs Verified

This is the most important product decision.

### Option A: Reuse `verified`

Use current fields:

```text
status = recorded | verified | disputed
verifiedAt
verifiedByUserId
```

Pros:

- No schema change.
- Existing status vocabulary already matches the workflow.
- Existing indexes already support `recorded` and `verified` queues.
- Reporting by reviewer is straightforward.

Cons:

- "Verified" may imply the money itself is verified, not only that billing reviewed and entered it into another platform.
- If future workflows need both payment verification and billing entry confirmation, this becomes overloaded.

Recommended if billing review means: "I checked this CRM payment and it is ready / entered into billing."

### Option B: Add Billing-Specific Fields

Add fields to `paymentRecords`:

```ts
billingReviewStatus?: "unreviewed" | "reviewed" | "needs_info";
billingReviewedAt?: number;
billingReviewedByUserId?: Id<"users">;
billingExternalReference?: string;
billingReviewNote?: string;
```

Likely indexes:

```text
by_tenantId_and_billingReviewStatus_and_recordedAt
by_tenantId_and_billingReviewedByUserId_and_billingReviewedAt
```

Pros:

- Clean separation from existing payment status.
- Supports "payment verified but not entered into billing" if needed.
- Gives room for external billing reference and reviewer notes.

Cons:

- Schema/data migration required.
- Existing rows need a rollout decision: `undefined` means unreviewed, or backfill to `unreviewed`.

Because this is a significant schema/data change, implementation should use the `convex-migration-helper` skill and a widen-migrate-narrow plan.

### Option C: Separate `billingPaymentReviews` Table

Create an append-only review table:

```ts
billingPaymentReviews: {
  tenantId,
  paymentRecordId,
  reviewerUserId,
  reviewedAt,
  status: "reviewed" | "needs_info",
  externalReference?,
  note?,
}
```

Pros:

- Strong audit trail.
- Multiple reviews or re-reviews are possible.
- Avoids high-churn fields on `paymentRecords`.

Cons:

- More joins/enrichment.
- Need a current-state projection or latest-review lookup.
- More implementation than MVP needs.

This is best if billing review becomes a multi-step approval process.

## Role And Permission Model

The current roles are:

```text
tenant_master
tenant_admin
closer
lead_generator
```

There is no dedicated billing admin role yet.

### MVP

Allow:

```text
tenant_master
tenant_admin
```

Add explicit permissions if desired:

```text
billing:view
billing:review
billing:export
```

### Specialized Role

If "specialized tenant-admin" means a real narrower access role, add:

```text
billing_admin
```

Then map it through WorkOS role slugs and local CRM roles. This is a schema/auth change and should be treated carefully:

- Update `users.role` union.
- Update WorkOS role mapping.
- Update permissions.
- Update team invitation/edit role UI.
- Update route guards.
- Backfill or manually assign users.

That should be a separate implementation phase, not a blocker for a tenant-admin MVP.

## Enrichment Query Shape

The Billing Ops list query should return a flattened row shape:

```ts
type BillingPaymentRow = {
  payment: {
    id: Id<"paymentRecords">;
    amountMinor: number;
    currency: string;
    recordedAt: number;
    status: "recorded" | "verified" | "disputed";
    paymentType: "monthly" | "split" | "pif" | "deposit";
    programName: string;
    origin: string;
    referenceCode?: string;
    note?: string;
    hasProofFile: boolean;
    canCorrect: boolean;
  };
  customer: {
    id: Id<"customers"> | null;
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };
  opportunity: {
    id: Id<"opportunities"> | null;
    status: string | null;
    source: string | null;
  };
  meeting: {
    id: Id<"meetings"> | null;
    scheduledAt: number | null;
  };
  enteredBy: {
    id: Id<"users">;
    name: string;
  };
  phoneCloser: {
    id: Id<"users"> | null;
    name: string | null;
  };
  dmAttribution: {
    teamName: string | null;
    dmCloserName: string | null;
    rawSource: string | null;
    rawMedium: string | null;
    resolution: "mapped" | "unmapped" | "internal" | "none";
  };
  slackOpener: {
    slackUserId: string | null;
    label: string | null;
    submittedAt: number | null;
  };
  review: {
    reviewedAt: number | null;
    reviewerName: string | null;
  };
};
```

Implementation notes:

- Keep the main payment query paginated.
- Enrich only the current page.
- Batch load users, customers, opportunities, meetings, DM teams, DM closers, and Slack users with bounded `Promise.all` calls.
- Avoid unbounded `.collect()`.
- Prefer `payment.meetingId` when present because payment-time context is usually more precise than opportunity-level fallback.

## Export Shape For External Billing

Billing Ops likely needs either a copy block or CSV export.

Suggested fields:

| Export column | Source |
| --- | --- |
| Payment ID | `payment._id` |
| Paid at | `payment.recordedAt` |
| Reviewed at | `payment.verifiedAt` or billing review field |
| Reviewer | `verifiedByUserId` display name |
| Customer name | `customer.fullName` |
| Customer email | `customer.email` |
| Customer phone | `customer.phone` |
| Amount | `amountMinor / 100` |
| Currency | `currency` |
| Payment program | `payment.programName` |
| Payment type | `payment.paymentType` |
| Reference code | `payment.referenceCode` |
| Internal note | `payment.note` |
| Entered by | `recordedByUserId` display name |
| Phone closer | `attributedCloserId` display name |
| DM team | `attributionTeams.displayName` |
| DM closer | `dmClosers.displayName` |
| Slack opener | `slackUsers.displayName/realName/username` |
| Opportunity ID | `opportunityId` / `originatingOpportunityId` |
| Meeting ID | `meetingId` |

Open question: should external billing platform IDs be written back into CRM? If yes, use `billingExternalReference` or a separate review record.

## Reporting Layer

Once review actions exist, useful billing reporting is small:

| Metric | Source |
| --- | --- |
| Unreviewed payment count | `status=recorded` or `billingReviewStatus=unreviewed` |
| Reviewed count by reviewer | `verifiedByUserId` / `billingReviewedByUserId` |
| Average review latency | `verifiedAt - recordedAt` |
| Oldest unreviewed payment | min `recordedAt` where unreviewed |
| Disputed count | `status=disputed` |
| Review throughput by day | `verifiedAt` bucket |
| Correction count | `payment.corrected` domain events |
| Corrected amount delta | `payment.corrected` metadata |

This can live under Billing Ops first. It does not need to be part of the broader reports system on day one.

## Edge Cases

### Payment Has No Customer

Possible for incomplete conversion, legacy rows, or side deals during conversion edge cases.

Fallback display:

```text
lead from opportunity.leadId
customer = "Not converted yet" or "Customer missing"
```

The row should still be reviewable only if billing accepts lead-level identity. Otherwise mark `needs_info` or block review.

### Payment Has No Meeting

Common for side deals and some reminder/post-conversion payments.

Fallback order:

1. `payment.meetingId`
2. `customer.winningMeetingId`
3. `opportunity.firstMeetingId`
4. `opportunity.latestMeetingId`
5. no meeting context

If no meeting exists, DM attribution may still be available on the opportunity.

### No DM Attribution

Display:

```text
No DM attribution
```

If raw UTM exists but is unmapped, display raw `utm_source` and `utm_medium` so billing can still proceed.

### Multiple Slack Qualification Events

Prefer `opportunity.qualifiedBy` for the original Slack opener. Use `slackQualificationEvents` as a fallback and diagnostic ledger.

### Admin-Logged Payment

Do not collapse `enteredBy` and `phoneCloser`.

Example:

```text
Entered by: Sarah Admin
Phone closer: Luke Jeffery
Origin: admin_meeting
```

### Post-Conversion Payment

These are non-commissionable by design today:

```text
contextType = customer
commissionable = false
origin = customer_direct
attributedCloserId = undefined
```

Billing Ops should still show the original winning opportunity, winning meeting, and conversion attribution where possible, but it should not invent a credited closer unless product decides post-conversion billing needs one.

### Corrected Payment

Corrections should preserve audit history. The current `paymentRecords` row can hold the latest corrected value, but the domain event should store enough metadata to understand what changed:

```json
{
  "amountMinor": { "from": 300000, "to": 350000 },
  "paymentType": { "from": "deposit", "to": "pif" },
  "reason": "Billing found checkout amount mismatch"
}
```

If product needs a full correction ledger with reviewer notes, attachments, and multiple correction rounds, use a separate `billingPaymentCorrections` table. That is a schema change and should go through the migration helper.

## Risks

### Attribution Drift

DM closer/team display names can change over time. Current rows store IDs and raw UTM values, so Billing Ops can resolve current labels and show raw fallback. If billing needs immutable labels exactly as of payment time, add review-time snapshots or payment-time denormalized fields.

### Overloading `verified`

If finance later distinguishes "payment verified" from "billing entry completed", reusing `verified` will be too coarse. Decide this before MVP implementation.

### Specialized Role Scope

Adding `billing_admin` affects WorkOS roles, Convex schema, invite flows, route guards, and UI role editing. It should not be bundled into the first queue unless access control is a hard requirement.

### External Billing Errors

If operators manually type into another platform, CRM can only show what should be entered. If we need reconciliation, CRM needs an external reference field and possibly import/reconciliation workflow.

### Silent Financial Edits

Amount/program/type corrections can change historical revenue reports and commission views. Billing Ops should never silently patch these fields. Every correction needs an actor, timestamp, reason, previous values, and refreshed aggregates.

## Suggested Implementation Phases

### Phase 0: Data Audit

- Query recent `paymentRecords`.
- Count missing `customerId`.
- Count missing `meetingId`.
- Count missing `attributedCloserId` on commissionable payments.
- Count opportunities with no `qualifiedBy` but linked Slack events.
- Confirm how often DM attribution is `mapped`, `unmapped`, `internal`, or `none`.

Goal: verify reconstruction quality before UI work.

### Phase 1: Read-Only Billing Queue

- Add `/workspace/billing`.
- Tenant-admin guarded.
- Paginated list of `status=recorded` payments.
- Enriched row data.
- Detail panel with proof/reference and attribution chain.
- No mutations yet.

Goal: let billing operators validate the data shape.

### Phase 2: Review Action

- Add `markPaymentReviewed` mutation.
- Reuse `verified` status if approved.
- Stamp reviewer and timestamp.
- Emit `payment.verified` domain event.
- Auto-advance UI to next payment.

Goal: make the queue operational.

### Phase 3: Payment Corrections

- Add `correctPayment` mutation for amount, payment type, payment program, reference code, and note.
- Require correction reason for financial fields.
- Update reporting aggregate through `replacePaymentAggregate`.
- Apply tenant stats deltas correctly.
- Refresh customer payment summary.
- Refresh sold-program caches when program changes.
- Emit `payment.corrected` domain event with old/new metadata.
- Decide whether corrected reviewed payments return to the review queue.

Goal: let billing fix bad CRM payment data without breaking reporting integrity.

### Phase 4: Export / Copy Workflow

- Add CSV export for current filters, capped and paginated appropriately.
- Add copy-to-clipboard block for one payment.
- Optionally add `billingExternalReference` if needed.

Goal: reduce manual billing data entry friction.

### Phase 5: Specialized Billing Role

- Add `billing_admin` only if tenant-admin access is too broad.
- Update WorkOS role mapping.
- Add billing permissions.
- Update invitations and role editing.
- Migrate existing users or assign manually.

Goal: least-privilege access for billing operators.

## Open Questions

1. Does "reviewed" mean the same thing as current `paymentRecords.status = "verified"`?
2. Should a reviewer be allowed to review a payment they personally entered?
3. Does billing need a `needs_info` state, or only reviewed/disputed?
4. Should external billing reference IDs be stored in CRM?
5. Should Billing Ops include non-commissionable post-conversion payments by default?
6. For Slack opener, should attribution always use the original `opportunity.qualifiedBy`, even if a later Slack qualification event touched the same opportunity?
7. Should exports include proof file URLs, knowing storage URLs are signed and time-limited?
8. Does billing need editable corrections, or should corrections happen in existing payment/customer screens?
9. Which payment fields can billing correct directly, and which require owner/admin intervention?
10. If a reviewed payment is corrected, should it become unreviewed again?
11. Should correction history live only in `domainEvents`, or does billing need a dedicated correction ledger table?

## Current Best Path

Start with a tenant-admin Billing Ops queue that reuses existing fields:

```text
unreviewed = payment.status === "recorded"
reviewed = payment.status === "verified"
reviewer = payment.verifiedByUserId
reviewedAt = payment.verifiedAt
```

This is the smallest useful version and likely enough to prove the workflow with the production test tenant. If product confirms that "verified" and "billing reviewed" are different states, switch to dedicated billing review fields before implementation and handle it as a migration.
