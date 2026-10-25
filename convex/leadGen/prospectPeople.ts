import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { emitDomainEvent, eventsForRecord } from "../lib/domainEvents";
import { advanceLeadLifecycle, prospectEvidence } from "../lib/leadLifecycle";
import { syncProspectConversions } from "../lib/prospectConversions";
import { resolveLeadIdentity } from "../leads/identityResolution";

// Every lead gen prospect is a person (docs/plans/phase-2-person-first.md
// §4.1): the capture finds or creates them before it inserts the prospect.

/**
 * The person who holds this Instagram handle, or a new person in
 * conversation, first seen at `capturedAt` (docs/plans/respark.md §4.1).
 */
export async function findOrCreateHandlePerson(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; normalizedHandle: string; capturedAt: number },
): Promise<{ lead: Doc<"leads">; created: boolean }> {
  const resolution = await resolveLeadIdentity(ctx, {
    tenantId: args.tenantId,
    socialHandle: { platform: "instagram", rawValue: args.normalizedHandle },
    identifierSource: "lead_gen",
    createdAt: args.capturedAt,
    createIdentifiers: true,
    initialLifecycle: { stage: "in_conversation", at: args.capturedAt },
  });
  return { lead: resolution.lead, created: resolution.isNewLead };
}

/**
 * The person's stage after a capture, and the prospect's conversion
 * entries, after the prospect is inserted.
 */
export async function settleProspectPerson(
  ctx: MutationCtx,
  prospect: Doc<"leadGenProspects">,
): Promise<void> {
  // Moves a person behind In conversation to it, and its entry time (and
  // Prospect's) earlier when the capture came first; never changes a later
  // stage, and never reopens a disposition (respark plan §4.1, Q1).
  for (const evidence of prospectEvidence(prospect)) {
    await advanceLeadLifecycle(ctx, prospect.leadId, { ...evidence, cause: "lead_gen_capture" });
  }
  await syncProspectConversions(ctx, prospect, await ctx.db.get("leads", prospect.leadId));
}

// --- Touch events. ---

export const LEAD_CAPTURED = "lead.captured";
export const LEAD_CAPTURE_VOIDED = "lead.capture_voided";

/** The submission's events of `eventType` at `occurredAt`. */
export async function submissionEvents(
  ctx: QueryCtx | MutationCtx,
  submission: Doc<"leadGenSubmissions">,
  eventType: typeof LEAD_CAPTURED | typeof LEAD_CAPTURE_VOIDED,
  occurredAt: number,
): Promise<Doc<"domainEvents">[]> {
  return await eventsForRecord(ctx, {
    tenantId: submission.tenantId,
    eventType,
    occurredAt,
    field: "submissionId",
    value: submission._id,
  });
}

function captureMetadata(submission: Doc<"leadGenSubmissions">) {
  return {
    submissionId: submission._id,
    prospectId: submission.prospectId,
    workerId: submission.workerId,
    source: submission.source,
    originKind: submission.originKind,
  };
}

/** A submission is a touch on the person's timeline, by the worker. */
export async function emitCaptureEvent(
  ctx: MutationCtx,
  submission: Doc<"leadGenSubmissions">,
  leadId: Id<"leads">,
  options: { skipAnalytics?: boolean } = {},
): Promise<void> {
  await emitDomainEvent(ctx, {
    tenantId: submission.tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: LEAD_CAPTURED,
    source: "pipeline",
    actorUserId: submission.userId,
    metadata: captureMetadata(submission),
    occurredAt: submission.submittedAt,
    skipAnalytics: options.skipAnalytics,
  });
}

/** An admin voided the submission. */
export async function emitCaptureVoidedEvent(
  ctx: MutationCtx,
  submission: Doc<"leadGenSubmissions">,
  leadId: Id<"leads">,
  options: { skipAnalytics?: boolean } = {},
): Promise<void> {
  if (submission.voidedAt === undefined) {
    throw new Error(`Submission ${submission._id} isn't voided`);
  }
  await emitDomainEvent(ctx, {
    tenantId: submission.tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: LEAD_CAPTURE_VOIDED,
    source: "admin",
    actorUserId: submission.voidedByUserId,
    reason: submission.voidReason,
    metadata: captureMetadata(submission),
    occurredAt: submission.voidedAt,
    skipAnalytics: options.skipAnalytics,
  });
}
