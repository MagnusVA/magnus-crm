import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import {
  LIFECYCLE_STAGES,
  advanceLifecycle,
  combineLifecycles,
  deriveLifecycle,
  isProspectStage,
  moveLifecycleBack,
  stageIndex,
  type Disposition,
  type LifecycleEvidence,
  type LifecycleStage,
  type LifecycleState,
} from "../leads/lifecycle";
import { leadStageEntries } from "../reporting/aggregates";
import { emitDomainEvent, type DomainEventSource } from "./domainEvents";
import {
  SLACK_OPPORTUNITY_EXPIRY_MS,
  SLACK_STALE_LOST_REASON,
} from "../pipeline/slackJoinLookup";
import { isActiveOpportunityStatus, updateTenantStats } from "./tenantStatsHelper";

// Writes a person's lifecycle stage and disposition, with the aggregate
// entries, counters, search row and domain events that follow them
// (docs/plans/phase-1-foundations.md §4-§5). Every stage write goes through
// here; the pure rules are in `convex/leads/lifecycle.ts`.

export type LifecycleCause =
  | "lead_gen_capture"
  | "slack_qualification"
  | "booking"
  | "side_deal"
  | "meeting_held"
  | "payment";

export function readLifecycle(lead: Doc<"leads">): LifecycleState | null {
  if (!lead.lifecycleStage) {
    return null;
  }
  return {
    stage: lead.lifecycleStage,
    enteredAt: lead.lifecycleStageEnteredAt ?? {},
  };
}

/** Whether `tenantStats.totalLeads` counts this lead. */
export function countsAsLead(lead: Doc<"leads">): boolean {
  return (
    lead.status === "active" &&
    (lead.lifecycleStage === undefined || !isProspectStage(lead.lifecycleStage))
  );
}

/** The lifecycle and disposition fields of a person created by `evidence`. */
export function initialLifecycleFields(evidence: LifecycleEvidence) {
  const state = advanceLifecycle(null, evidence.stage, evidence.at);
  return {
    lifecycleStage: state.stage,
    lifecycleStageEnteredAt: state.enteredAt,
    disposition: "open" as const,
    dispositionSetAt: evidence.at,
    dispositionSource: "system" as const,
  };
}

function stageEntryId(leadId: Id<"leads">, stage: LifecycleStage): string {
  return `${leadId}:${stage}`;
}

/** Brings the lead's `leadStageEntries` entries from `before` to `after`. */
export async function syncLeadStageEntries(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  before: LifecycleState | null,
  after: LifecycleState | null,
): Promise<void> {
  for (const stage of LIFECYCLE_STAGES) {
    const from = before?.enteredAt[stage];
    const to = after?.enteredAt[stage];
    if (from === to) {
      continue;
    }
    const id = stageEntryId(leadId, stage);
    if (from === undefined && to !== undefined) {
      await leadStageEntries.insertIfDoesNotExist(ctx, {
        namespace: tenantId,
        key: [stage, to],
        id,
      });
    } else if (from !== undefined && to === undefined) {
      await leadStageEntries.deleteIfExists(ctx, {
        namespace: tenantId,
        key: [stage, from],
        id,
      });
    } else if (from !== undefined && to !== undefined) {
      await leadStageEntries.replaceOrInsert(
        ctx,
        { namespace: tenantId, key: [stage, from], id },
        { namespace: tenantId, key: [stage, to] },
      );
    }
  }
}

/** People who first reached `stage` in `[startAt, endAt)`. */
export async function countLeadStageEntries(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  stage: LifecycleStage,
  startAt: number,
  endAt: number,
): Promise<number> {
  return await leadStageEntries.count(ctx, {
    namespace: tenantId,
    bounds: {
      lower: { key: [stage, startAt], inclusive: true },
      upper: { key: [stage, endAt], inclusive: false },
    },
  });
}

type LifecycleWrite = {
  /** The backfill records state, not touches, so it emits no event. */
  quiet?: boolean;
  source: DomainEventSource;
  actorUserId?: Id<"users">;
  reason: string;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
  extraPatch?: Partial<Doc<"leads">>;
};

/**
 * Stores `after` on the lead with everything that follows a stage write: the
 * aggregate entries, `totalLeads` and the search row when the person crosses
 * Qualified, and a domain event when the stage itself changes.
 */
async function writeLifecycle(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  before: LifecycleState | null,
  after: LifecycleState,
  write: LifecycleWrite,
): Promise<void> {
  await ctx.db.patch("leads", lead._id, {
    lifecycleStage: after.stage,
    lifecycleStageEnteredAt: after.enteredAt,
    ...write.extraPatch,
  });
  await syncLeadStageEntries(ctx, lead.tenantId, lead._id, before, after);

  // A lead without a stage counts as a lead (`countsAsLead`).
  const wasProspect = before ? isProspectStage(before.stage) : false;
  const isProspect = isProspectStage(after.stage);
  if (wasProspect !== isProspect && lead.status === "active") {
    await updateTenantStats(ctx, lead.tenantId, { totalLeads: isProspect ? -1 : 1 });
  }
  // The row already shows a lead without a stage as a lead.
  if (wasProspect !== isProspect) {
    await rebuildLeadCustomerSearchRow(ctx, lead.tenantId, lead._id);
  }
  if (!write.quiet && before && before.stage !== after.stage) {
    await emitDomainEvent(ctx, {
      tenantId: lead.tenantId,
      entityType: "lead",
      entityId: lead._id,
      eventType: "lead.lifecycle_stage_changed",
      source: write.source,
      actorUserId: write.actorUserId,
      fromStatus: before.stage,
      toStatus: after.stage,
      reason: write.reason,
      metadata: write.metadata,
      occurredAt: write.occurredAt,
    });
  }
}

function sameLifecycle(a: LifecycleState | null, b: LifecycleState | null): boolean {
  return (
    a?.stage === b?.stage &&
    LIFECYCLE_STAGES.every((stage) => a?.enteredAt[stage] === b?.enteredAt[stage])
  );
}

/**
 * The lead reached `evidence.stage` at `evidence.at`. A lead the lifecycle
 * backfill hasn't reached yet is left alone: the backfill derives its whole
 * history from source data, this event included. A merged lead never moves.
 * The system moves the stage, so its events have source `system` and the
 * cause as their reason.
 */
export async function advanceLeadLifecycle(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  evidence: LifecycleEvidence & { cause: LifecycleCause },
): Promise<void> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.status === "merged") {
    return;
  }
  const before = readLifecycle(lead);
  if (!before) {
    return;
  }
  const after = advanceLifecycle(before, evidence.stage, evidence.at);
  // Newer evidence of interest reopens a person the system set aside (D3).
  const reopens =
    !isProspectStage(evidence.stage) &&
    lead.disposition === "unresponsive" &&
    lead.dispositionSource === "system" &&
    evidence.at > (lead.dispositionSetAt ?? 0);
  if (sameLifecycle(before, after) && !reopens) {
    return;
  }
  await writeLifecycle(ctx, lead, before, after, {
    source: "system",
    reason: evidence.cause,
    occurredAt: evidence.at,
    extraPatch: reopens
      ? {
          disposition: "open",
          dispositionSetAt: evidence.at,
          dispositionSource: "system",
          dispositionReason: evidence.cause,
        }
      : undefined,
  });
  if (reopens) {
    await emitDispositionChanged(ctx, lead, "open", evidence.cause, evidence.at);
  }
}

async function emitDispositionChanged(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  to: Disposition,
  reason: string,
  at: number,
): Promise<void> {
  await emitDomainEvent(ctx, {
    tenantId: lead.tenantId,
    entityType: "lead",
    entityId: lead._id,
    eventType: "lead.disposition_changed",
    source: "system",
    fromStatus: lead.disposition,
    toStatus: to,
    reason,
    occurredAt: at,
  });
}

// --- Evidence: one rule per source record (plan §4.1). The write paths and
// the backfill read the same functions, so they agree on every time. ---

export function slackQualificationEvidence(
  event: Doc<"slackQualificationEvents">,
): LifecycleEvidence[] {
  return [{ stage: "qualified", at: event.submittedAt }];
}

export function opportunityEvidence(
  opportunity: Doc<"opportunities">,
): LifecycleEvidence[] {
  if (opportunity.source === "slack_qualified") {
    const at = opportunity.qualifiedAt ?? opportunity.qualifiedBy?.submittedAt;
    return at === undefined ? [] : [{ stage: "qualified", at }];
  }
  if (opportunity.source === "side_deal") {
    // A side deal records a call that already happened (ADR 0001: Call held).
    return [{ stage: "showed", at: opportunity.createdAt }];
  }
  return [];
}

export function meetingEvidence(meeting: Doc<"meetings">): LifecycleEvidence[] {
  // `createdAt` is the Calendly envelope's `created_at`: the booking time.
  const evidence: LifecycleEvidence[] = [
    { stage: "booked", at: meeting.createdAt },
  ];
  if (meeting.status === "completed") {
    // The call time, not the time a closer recorded the outcome. An admin can
    // record one early, so it never goes past `completedAt`.
    const at = Math.min(
      meeting.scheduledAt,
      meeting.completedAt ?? meeting.scheduledAt,
    );
    evidence.push({ stage: "showed", at });
  }
  return evidence;
}

export function paymentEvidence(
  payment: Doc<"paymentRecords">,
): LifecycleEvidence[] {
  return payment.status === "disputed"
    ? []
    : [{ stage: "customer", at: payment.recordedAt }];
}

export function customerEvidence(
  customer: Doc<"customers">,
): LifecycleEvidence[] {
  return [{ stage: "customer", at: customer.convertedAt }];
}

export function prospectCaptureEvidence(
  match: Doc<"leadGenAuditMatches">,
  prospect: Doc<"leadGenProspects"> | null,
): LifecycleEvidence[] {
  return match.matchStatus === "accepted" && prospect
    ? [{ stage: "prospect", at: prospect.firstCapturedAt }]
    : [];
}

// --- Hooks: each write path calls the one for the record it wrote. ---

async function applyEvidence(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  evidence: LifecycleEvidence[],
  cause: LifecycleCause,
): Promise<void> {
  for (const item of evidence) {
    await advanceLeadLifecycle(ctx, leadId, { ...item, cause });
  }
}

export async function recordSlackQualification(
  ctx: MutationCtx,
  eventId: Id<"slackQualificationEvents">,
): Promise<void> {
  const event = await ctx.db.get("slackQualificationEvents", eventId);
  if (!event?.leadId) {
    return;
  }
  await applyEvidence(
    ctx,
    event.leadId,
    slackQualificationEvidence(event),
    "slack_qualification",
  );
}

/** A meeting was booked, or its outcome recorded. */
export async function recordMeeting(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<void> {
  const meeting = await ctx.db.get("meetings", meetingId);
  const opportunity =
    meeting && (await ctx.db.get("opportunities", meeting.opportunityId));
  if (!meeting || !opportunity) {
    return;
  }
  for (const item of meetingEvidence(meeting)) {
    await advanceLeadLifecycle(
      ctx,
      opportunity.leadId,
      { ...item, cause: item.stage === "booked" ? "booking" : "meeting_held" },
    );
  }
}

/** A deal was created: a Slack qualification or a side deal. */
export async function recordOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity) {
    return;
  }
  for (const item of opportunityEvidence(opportunity)) {
    await advanceLeadLifecycle(
      ctx,
      opportunity.leadId,
      {
        ...item,
        cause: item.stage === "showed" ? "side_deal" : "slack_qualification",
      },
    );
  }
}

/** A payment was recorded, on a deal or on a customer. */
export async function recordPayment(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<void> {
  const payment = await ctx.db.get("paymentRecords", paymentId);
  if (!payment) {
    return;
  }
  const leadId = await paymentLeadId(ctx, payment);
  if (leadId) {
    await applyEvidence(ctx, leadId, paymentEvidence(payment), "payment");
  }
}

async function paymentLeadId(
  ctx: MutationCtx,
  payment: Doc<"paymentRecords">,
): Promise<Id<"leads"> | undefined> {
  if (payment.opportunityId) {
    const opportunity = await ctx.db.get("opportunities", payment.opportunityId);
    if (opportunity) {
      return opportunity.leadId;
    }
  }
  if (payment.customerId) {
    const customer = await ctx.db.get("customers", payment.customerId);
    return customer?.leadId;
  }
  return undefined;
}

/** A lead was converted, by a payment or by an admin. */
export async function recordCustomer(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<void> {
  const customer = await ctx.db.get("customers", customerId);
  if (customer) {
    await applyEvidence(ctx, customer.leadId, customerEvidence(customer), "payment");
  }
}

/** Lead gen had captured the person before they were qualified. */
export async function recordProspectCapture(
  ctx: MutationCtx,
  matchId: Id<"leadGenAuditMatches">,
): Promise<void> {
  const match = await ctx.db.get("leadGenAuditMatches", matchId);
  if (!match) {
    return;
  }
  const prospect = await ctx.db.get("leadGenProspects", match.prospectId);
  await applyEvidence(
    ctx,
    match.leadId,
    prospectCaptureEvidence(match, prospect),
    "lead_gen_capture",
  );
}

// --- Deriving from source data: the backfill, its assert, and corrections. ---

// Far above any production lead (the largest has 19 deals). A lead past a
// bound throws rather than derive a stage from partial data.
const DERIVE_READ_LIMIT = 200;

function bounded<T>(rows: T[], what: string, leadId: Id<"leads">): T[] {
  if (rows.length > DERIVE_READ_LIMIT) {
    throw new Error(`Lifecycle derivation for lead ${leadId} read more than ${DERIVE_READ_LIMIT} ${what}`);
  }
  return rows;
}

/** Every piece of stage evidence for one lead, from the records it owns now. */
export async function collectLifecycleEvidence(
  ctx: QueryCtx | MutationCtx,
  lead: Doc<"leads">,
): Promise<{ evidence: LifecycleEvidence[]; opportunities: Doc<"opportunities">[] }> {
  const { tenantId, _id: leadId } = lead;
  const evidence: LifecycleEvidence[] = [];
  const opportunities = bounded(
    await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      .take(DERIVE_READ_LIMIT + 1),
    "deals",
    leadId,
  );
  const paymentIds = new Set<Id<"paymentRecords">>();
  for (const opportunity of opportunities) {
    evidence.push(...opportunityEvidence(opportunity));
    const meetings = bounded(
      await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
        .take(DERIVE_READ_LIMIT + 1),
      "meetings",
      leadId,
    );
    for (const meeting of meetings) {
      evidence.push(...meetingEvidence(meeting));
    }
    const payments = bounded(
      await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunity._id))
        .take(DERIVE_READ_LIMIT + 1),
      "payments",
      leadId,
    );
    for (const payment of payments) {
      paymentIds.add(payment._id);
      evidence.push(...paymentEvidence(payment));
    }
  }
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
    .first();
  if (customer) {
    evidence.push(...customerEvidence(customer));
    const customerPayments = bounded(
      await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId_and_recordedAt", (q) => q.eq("customerId", customer._id))
        .take(DERIVE_READ_LIMIT + 1),
      "customer payments",
      leadId,
    );
    for (const payment of customerPayments) {
      if (!paymentIds.has(payment._id)) {
        evidence.push(...paymentEvidence(payment));
      }
    }
  }
  const events = bounded(
    await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      .take(DERIVE_READ_LIMIT + 1),
    "Slack qualifications",
    leadId,
  );
  for (const event of events) {
    evidence.push(...slackQualificationEvidence(event));
  }
  const matches = bounded(
    await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      .take(DERIVE_READ_LIMIT + 1),
    "lead gen matches",
    leadId,
  );
  for (const match of matches) {
    const prospect = await ctx.db.get("leadGenProspects", match.prospectId);
    evidence.push(...prospectCaptureEvidence(match, prospect));
  }
  return { evidence, opportunities };
}

/** The lifecycle a lead's own records support, or null for a merged lead. */
export async function deriveLeadLifecycle(
  ctx: QueryCtx | MutationCtx,
  lead: Doc<"leads">,
): Promise<LifecycleState | null> {
  if (lead.status === "merged") {
    return null;
  }
  return deriveLifecycle((await collectLifecycleEvidence(ctx, lead)).evidence);
}

export type LifecycleCorrection = "payment_voided";

/**
 * Sets the lead's lifecycle to what its records support now, which can move
 * it back. Only corrections call this, today a voided payment (plan §4.3).
 * A lead whose records support no stage keeps the one it has: every person
 * has a stage.
 */
export async function correctLeadLifecycle(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  correction: LifecycleCorrection,
  actorUserId?: Id<"users">,
): Promise<void> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead || lead.status === "merged") {
    return;
  }
  const before = readLifecycle(lead);
  const after = await deriveLeadLifecycle(ctx, lead);
  if (!after || sameLifecycle(before, after)) {
    return;
  }
  // After an admin's move-back the records overstate the stage, so a
  // correction may only take the person lower.
  if (
    lead.lifecycleStageMovedBackAt !== undefined &&
    before &&
    stageIndex(after.stage) >= stageIndex(before.stage)
  ) {
    return;
  }
  await writeLifecycle(ctx, lead, before, after, {
    source: actorUserId ? "admin" : "system",
    actorUserId,
    reason: correction,
    metadata: before ? { enteredAtBefore: before.enteredAt } : undefined,
  });
}

/**
 * A merge joins two records of one person. Call it after the source's records
 * have moved to the target and before the source is marked merged. The
 * target takes the higher stage and the earlier time for each stage; the
 * source keeps its frozen fields and leaves the counts (plan §4.4).
 */
export async function mergeLeadLifecycle(
  ctx: MutationCtx,
  sourceLead: Doc<"leads">,
  targetLeadId: Id<"leads">,
  actorUserId: Id<"users">,
): Promise<void> {
  const source = readLifecycle(sourceLead);
  await syncLeadStageEntries(ctx, sourceLead.tenantId, sourceLead._id, source, null);

  const target = await ctx.db.get("leads", targetLeadId);
  const before = target && readLifecycle(target);
  if (!target || !before) {
    return;
  }
  const after = source
    ? combineLifecycles(before, source)
    : await deriveLeadLifecycle(ctx, target);
  if (!after || sameLifecycle(before, after)) {
    return;
  }
  await writeLifecycle(ctx, target, before, after, {
    source: "admin",
    actorUserId,
    reason: "merge",
    metadata: { sourceLeadId: sourceLead._id },
  });
}

// --- Disposition (plan §4.5). ---

export const SLACK_STALE_DISPOSITION_REASON = "slack_deal_expired";

/**
 * Whether a person whose Slack deal just expired should become `unresponsive`:
 * still `open`, and no other deal of theirs is open.
 */
export function shouldMarkUnresponsive(
  lead: Doc<"leads">,
  opportunities: readonly Doc<"opportunities">[],
): boolean {
  return (
    lead.status !== "merged" &&
    readLifecycle(lead) !== null &&
    (lead.disposition ?? "open") === "open" &&
    !opportunities.some((opportunity) => isActiveOpportunityStatus(opportunity.status))
  );
}

/** A Slack deal of this lead expired as stale at `at` (D3). */
export async function recordSlackDealExpired(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  at: number,
): Promise<void> {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead) {
    return;
  }
  // A person with more than this many deals has a live one in practice; the
  // cap keeps the read bounded, and leaves the disposition alone.
  const opportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", lead.tenantId).eq("leadId", leadId))
    .take(DERIVE_READ_LIMIT + 1);
  if (opportunities.length > DERIVE_READ_LIMIT || !shouldMarkUnresponsive(lead, opportunities)) {
    return;
  }
  await ctx.db.patch("leads", leadId, {
    disposition: "unresponsive",
    dispositionSetAt: at,
    dispositionSource: "system",
    dispositionReason: SLACK_STALE_DISPOSITION_REASON,
  });
  await emitDispositionChanged(ctx, lead, "unresponsive", SLACK_STALE_DISPOSITION_REASON, at);
}

/** Drops the stage entries of a lead that is about to be deleted. */
export async function deleteLeadStageEntries(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<void> {
  await syncLeadStageEntries(ctx, lead.tenantId, lead._id, readLifecycle(lead), null);
}

// --- Backfill and assert (plan §9.2). ---

/**
 * The disposition the backfill gives a lead that has none (D3): unresponsive
 * if a Slack deal expired, no deal is open, and nothing at Qualified or later
 * happened after the expiry; else open.
 */
export function backfillDisposition(
  state: LifecycleState,
  evidence: readonly LifecycleEvidence[],
  opportunities: readonly Doc<"opportunities">[],
) {
  const expiries = opportunities
    .filter(
      (opportunity) =>
        opportunity.source === "slack_qualified" &&
        opportunity.status === "lost" &&
        opportunity.lostReason === SLACK_STALE_LOST_REASON,
    )
    // The backlog run stamped `lostAt` on 2026-10-16; the deal really expired
    // a join window after it was created.
    .map((opportunity) =>
      Math.min(opportunity.lostAt ?? Infinity, opportunity.createdAt + SLACK_OPPORTUNITY_EXPIRY_MS),
    );
  const lastExpiry = expiries.length > 0 ? Math.max(...expiries) : undefined;
  const reopened =
    lastExpiry !== undefined &&
    evidence.some((item) => !isProspectStage(item.stage) && item.at > lastExpiry);
  const anyOpen = opportunities.some((opportunity) => isActiveOpportunityStatus(opportunity.status));
  if (lastExpiry !== undefined && !reopened && !anyOpen) {
    return {
      disposition: "unresponsive" as const,
      dispositionSetAt: lastExpiry,
      dispositionSource: "system" as const,
      dispositionReason: SLACK_STALE_DISPOSITION_REASON,
    };
  }
  return {
    disposition: "open" as const,
    dispositionSetAt: state.enteredAt.prospect ?? state.enteredAt[state.stage],
    dispositionSource: "system" as const,
  };
}

/** Writes the lifecycle a lead's records support, and a disposition if it has none. */
export async function backfillLeadLifecycleRow(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<"merged" | "no_evidence" | "unchanged" | "written"> {
  if (lead.status === "merged") {
    return "merged";
  }
  const { evidence, opportunities } = await collectLifecycleEvidence(ctx, lead);
  const after = deriveLifecycle(evidence);
  if (!after) {
    // No record to date a stage from, but every person has a disposition.
    if (lead.disposition === undefined) {
      await ctx.db.patch("leads", lead._id, {
        disposition: "open",
        dispositionSetAt: lead.firstSeenAt,
        dispositionSource: "system",
      });
    }
    return "no_evidence";
  }
  const before = readLifecycle(lead);
  const disposition =
    lead.disposition === undefined ? backfillDisposition(after, evidence, opportunities) : undefined;
  if (sameLifecycle(before, after) && !disposition) {
    return "unchanged";
  }
  await writeLifecycle(ctx, lead, before, after, {
    quiet: true,
    source: "system",
    reason: "backfill",
    extraPatch: disposition,
  });
  return "written";
}

async function hasStageEntry(
  ctx: QueryCtx | MutationCtx,
  lead: Doc<"leads">,
  stage: LifecycleStage,
  at: number,
): Promise<boolean> {
  const bound = { key: [stage, at] as [LifecycleStage, number], id: stageEntryId(lead._id, stage), inclusive: true };
  return (
    (await leadStageEntries.count(ctx, {
      namespace: lead.tenantId,
      bounds: { lower: bound, upper: bound },
    })) === 1
  );
}

/** What is wrong with a lead's stored lifecycle, compared with its records. */
export async function lifecycleProblems(
  ctx: QueryCtx | MutationCtx,
  lead: Doc<"leads">,
): Promise<string[]> {
  const stored = readLifecycle(lead);
  const problems: string[] = [];
  if (lead.status === "merged") {
    for (const stage of LIFECYCLE_STAGES) {
      const at = stored?.enteredAt[stage];
      if (at !== undefined && (await hasStageEntry(ctx, lead, stage, at))) {
        problems.push(`merged lead has a ${stage} entry`);
      }
    }
    return problems;
  }
  const derived = await deriveLeadLifecycle(ctx, lead);
  // An admin's move-back is a correction the records don't show.
  if (lead.lifecycleStageMovedBackAt === undefined && !sameLifecycle(stored, derived)) {
    problems.push("stage or entry times differ from its records");
  }
  for (const stage of LIFECYCLE_STAGES) {
    const at = stored?.enteredAt[stage];
    if (at !== undefined && !(await hasStageEntry(ctx, lead, stage, at))) {
      problems.push(`missing ${stage} entry`);
    }
  }
  if ((lead.status === "converted") !== (stored?.stage === "customer")) {
    problems.push(`status ${lead.status} with stage ${stored?.stage}`);
  }
  if (lead.disposition === undefined) {
    problems.push("no disposition");
  }
  return problems;
}

/** People who reached each stage, over all time, from `leadStageEntries`. */
export async function leadStageTotals(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Record<LifecycleStage, number>> {
  const totals = {} as Record<LifecycleStage, number>;
  for (const stage of LIFECYCLE_STAGES) {
    totals[stage] = await countLeadStageEntries(ctx, tenantId, stage, 0, Number.MAX_SAFE_INTEGER);
  }
  return totals;
}

// --- Admin controls (plan §4.3, §4.5, D4). ---

/** An admin moves the stage back; the stages above it stop counting. */
export async function adminMoveLifecycleBack(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  toStage: LifecycleStage,
  write: { actorUserId: Id<"users">; reason: string; at: number },
): Promise<void> {
  const before = readLifecycle(lead);
  if (!before) {
    throw new Error("Lead has no lifecycle stage yet");
  }
  await writeLifecycle(ctx, lead, before, moveLifecycleBack(before, toStage), {
    source: "admin",
    actorUserId: write.actorUserId,
    reason: write.reason,
    occurredAt: write.at,
    metadata: { enteredAtBefore: before.enteredAt },
    extraPatch: { lifecycleStageMovedBackAt: write.at },
  });
}

/** An admin sets the disposition; only an admin changes it from then on. */
export async function adminSetDisposition(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  disposition: Disposition,
  write: { actorUserId: Id<"users">; reason: string; at: number },
): Promise<void> {
  await ctx.db.patch("leads", lead._id, {
    disposition,
    dispositionSetAt: write.at,
    dispositionSource: "admin",
    dispositionReason: write.reason,
  });
  await emitDomainEvent(ctx, {
    tenantId: lead.tenantId,
    entityType: "lead",
    entityId: lead._id,
    eventType: "lead.disposition_changed",
    source: "admin",
    actorUserId: write.actorUserId,
    fromStatus: lead.disposition,
    toStatus: disposition,
    reason: write.reason,
    occurredAt: write.at,
  });
}
