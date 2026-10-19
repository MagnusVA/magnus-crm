import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { advanceLeadLifecycle } from "../lib/leadLifecycle";
import { syncProspectConversions } from "../lib/prospectConversions";
import { followMergeChain, resolveLeadIdentity } from "../leads/identityResolution";

// Every lead gen prospect is a person (docs/plans/phase-2-person-first.md
// §4.1). The capture, the Slack audit match and the link backfill all link a
// prospect through `linkProspectPerson`, so they agree on who it is.

/**
 * The person a prospect is: its accepted audit match's lead, followed through
 * merges; else the person who holds its Instagram handle; else a new person
 * at Prospect. A placeholder handle gets a person with no identifier (D1).
 */
async function findOrCreateProspectPerson(
  ctx: MutationCtx,
  prospect: Doc<"leadGenProspects">,
): Promise<{ lead: Doc<"leads">; created: boolean }> {
  if (prospect.currentAuditMatchId) {
    const match = await ctx.db.get("leadGenAuditMatches", prospect.currentAuditMatchId);
    const matched =
      match?.matchStatus === "accepted" && match.prospectId === prospect._id
        ? await ctx.db.get("leads", match.leadId)
        : null;
    const lead =
      matched && matched.tenantId === prospect.tenantId
        ? await followMergeChain(ctx, matched)
        : undefined;
    if (lead) {
      return { lead, created: false };
    }
  }
  const resolution = await resolveLeadIdentity(ctx, {
    tenantId: prospect.tenantId,
    socialHandle: { platform: "instagram", rawValue: prospect.normalizedHandle },
    identifierSource: "lead_gen",
    createdAt: prospect.firstCapturedAt,
    createIdentifiers: true,
    initialLifecycle: { stage: "prospect", at: prospect.firstCapturedAt },
    allowNoIdentifier: true,
  });
  return { lead: resolution.lead, created: resolution.isNewLead };
}

/**
 * Sets the prospect's person, if it has none, and the person's Prospect
 * entry time and conversion entries. Safe to run again.
 */
export async function linkProspectPerson(
  ctx: MutationCtx,
  prospectId: Id<"leadGenProspects">,
): Promise<{ leadId: Id<"leads">; created: boolean }> {
  const prospect = await ctx.db.get("leadGenProspects", prospectId);
  if (!prospect) {
    throw new Error(`Prospect ${prospectId} not found`);
  }
  if (prospect.leadId) {
    return { leadId: prospect.leadId, created: false };
  }
  const { lead, created } = await findOrCreateProspectPerson(ctx, prospect);
  await ctx.db.patch("leadGenProspects", prospect._id, { leadId: lead._id });
  // Moves the Prospect entry time earlier when the capture came first; never
  // changes a later stage.
  await advanceLeadLifecycle(ctx, lead._id, {
    stage: "prospect",
    at: prospect.firstCapturedAt,
    cause: "lead_gen_capture",
  });
  await syncProspectConversions(
    ctx,
    { ...prospect, leadId: lead._id },
    await ctx.db.get("leads", lead._id),
  );
  return { leadId: lead._id, created };
}

// --- Touch events. ---

export const LEAD_CAPTURED = "lead.captured";
export const LEAD_CAPTURE_VOIDED = "lead.capture_voided";

// Far above the events of one type that share one millisecond; a scan past
// it throws rather than miss the submission's event.
const SAME_TIME_EVENT_SCAN_LIMIT = 2000;

function metadataSubmissionId(metadata: string | undefined): unknown {
  if (!metadata) {
    return undefined;
  }
  try {
    return (JSON.parse(metadata) as Record<string, unknown>).submissionId;
  } catch {
    return undefined;
  }
}

/**
 * The submission's events of `eventType` at `occurredAt`. Found by type and
 * time rather than by person, so a person merged since still finds them.
 */
export async function submissionEvents(
  ctx: QueryCtx | MutationCtx,
  submission: Doc<"leadGenSubmissions">,
  eventType: typeof LEAD_CAPTURED | typeof LEAD_CAPTURE_VOIDED,
  occurredAt: number,
): Promise<Doc<"domainEvents">[]> {
  const matches: Doc<"domainEvents">[] = [];
  let scanned = 0;
  for await (const event of ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
      q.eq("tenantId", submission.tenantId).eq("eventType", eventType).eq("occurredAt", occurredAt),
    )) {
    scanned += 1;
    if (scanned > SAME_TIME_EVENT_SCAN_LIMIT) {
      throw new Error(`More than ${SAME_TIME_EVENT_SCAN_LIMIT} ${eventType} events at ${occurredAt}`);
    }
    if (metadataSubmissionId(event.metadata) === submission._id) {
      matches.push(event);
    }
  }
  return matches;
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
