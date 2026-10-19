/**
 * Moves rows that reference one lead onto another lead.
 *
 * A merge moves everything a lead has. The polluted-lead split
 * (docs/plans/polluted-lead-split.md §5.6) moves only some of a lead's
 * opportunities, so the work is divided by what a row is keyed by:
 *
 * - `moveOpportunityToLead` moves one opportunity and every row keyed by it
 *   or by its meetings.
 * - `moveMeetingToOpportunity` moves one meeting to another opportunity, for
 *   a deal that two people's bookings ended up on.
 * - `moveRemainingLeadRows` moves the rows keyed only by the lead. Run after
 *   the opportunities, it also catches rows whose copied `leadId` disagreed
 *   with their opportunity.
 * - `moveFormResponsesPage` moves form responses by lead, one page at a time,
 *   because a lead can have hundreds.
 *
 * These keep the moved rows' own copies current: each moved opportunity's
 * search row, its meetings' `leadName`, and its Slack events' operations
 * rows. They don't rebuild either lead's lead/customer search row, which
 * reads up to 100 of the lead's opportunities, so after the last move the
 * caller runs `rebuildLeadCustomerSearchRow` once for each lead.
 *
 * Every read is bounded. When a read in `moveOpportunityToLead` or
 * `moveRemainingLeadRows` fills its bound, its name goes in `boundsHit` and
 * rows past the bound stay where they were; the caller logs it. Prospects and
 * copy events instead page through `moveTouchRowsPage`.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { upsertOpportunitySearchProjection } from "../lib/opportunitySearch";
import { syncProspectConversions } from "../lib/prospectConversions";
import { rebuildQualificationRow } from "../operations/projections";
import { replaceMeetingAggregate } from "../reporting/writeHooks";

// Far above any real count per opportunity, meeting, or lead. The most
// polluted lead in production has 65 meetings across all its opportunities.
const ROW_LIMIT = 200;

export type OpportunityMoveResult = {
  meetings: number;
  followUps: number;
  formResponses: number;
  qualificationEvents: number;
  auditMatches: number;
  webhookDeliveries: number;
  boundsHit: string[];
};

export type LeadRowsMoveResult = {
  notes: number;
  portalEdits: number;
  followUps: number;
  qualificationEvents: number;
  auditMatches: number;
  prospects: number;
  copyEvents: number;
  /** More prospects or copy events than one page; continue with `moveTouchRowsPage`. */
  hasMoreTouches: boolean;
  boundsHit: string[];
};

function noteBound(boundsHit: string[], name: string, rows: unknown[]) {
  if (rows.length === ROW_LIMIT && !boundsHit.includes(name)) {
    boundsHit.push(name);
  }
}

/**
 * Moves one opportunity to `toLeadId`, with its follow-ups, Slack
 * qualification events and their operations rows, lead gen audit matches,
 * and its meetings' webhook receipts and (optionally) form responses.
 * Clears `potentialDuplicateLeadId` when it names `toLeadId`, and sets the
 * meetings' `leadName`.
 *
 * Safe to run again: rows already on `toLeadId` are left alone.
 */
export async function moveOpportunityToLead(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    toLeadId: Id<"leads">;
    /** The new lead's display name (`leadDisplayString`), copied onto meetings. */
    leadName: string;
    now: number;
    /**
     * Whether to move the form responses of the opportunity's meetings here.
     * A merge passes false and moves them by lead with
     * `moveFormResponsesPage`, so a large lead can be paged.
     */
    moveFormResponses: boolean;
  },
): Promise<OpportunityMoveResult> {
  const { tenantId, opportunityId, toLeadId, now } = args;
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  // On the new lead, a flag naming that lead would point at itself.
  const clearsDuplicateFlag = opportunity.potentialDuplicateLeadId === toLeadId;
  if (opportunity.leadId !== toLeadId || clearsDuplicateFlag) {
    // Not `patchOpportunityLifecycle`: it rebuilds the new lead's
    // lead/customer row on every call, once per moved opportunity. Neither
    // field keys an aggregate; the caller rebuilds both leads' rows once.
    // `updatedAt` stays: moving the deal to another lead isn't activity on
    // it, and a newer `updatedAt` makes the pipeline hold every earlier
    // booking for this person as historical_booking_requires_review.
    await ctx.db.patch("opportunities", opportunityId, {
      leadId: toLeadId,
      ...(clearsDuplicateFlag ? { potentialDuplicateLeadId: undefined } : {}),
    });
  }
  await upsertOpportunitySearchProjection(ctx, opportunityId);

  const result: OpportunityMoveResult = {
    meetings: 0,
    followUps: 0,
    formResponses: 0,
    qualificationEvents: 0,
    auditMatches: 0,
    webhookDeliveries: 0,
    boundsHit: [],
  };

  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "meetings", meetings);
  result.meetings = meetings.length;

  for (const meeting of meetings) {
    if (meeting.leadName !== args.leadName) {
      await ctx.db.patch("meetings", meeting._id, { leadName: args.leadName });
    }

    // Receipts have no lead index. The processor writes `leadId` only on a
    // receipt whose invitee URI is its meeting's, so the invitee finds them.
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_inviteeUri_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("inviteeUri", meeting.calendlyInviteeUri),
      )
      .take(ROW_LIMIT);
    noteBound(result.boundsHit, "webhook_deliveries", deliveries);
    for (const delivery of deliveries) {
      if (delivery.meetingId !== meeting._id || delivery.leadId === toLeadId) {
        continue;
      }
      await ctx.db.patch("webhookDeliveries", delivery._id, {
        leadId: toLeadId,
      });
      result.webhookDeliveries += 1;
    }

    if (!args.moveFormResponses) {
      continue;
    }
    const responses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .take(ROW_LIMIT);
    noteBound(result.boundsHit, "form_responses", responses);
    for (const response of responses) {
      if (response.leadId === toLeadId) {
        continue;
      }
      await ctx.db.patch("meetingFormResponses", response._id, {
        leadId: toLeadId,
      });
      result.formResponses += 1;
    }
  }

  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", opportunityId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "follow_ups", followUps);
  for (const followUp of followUps) {
    if (followUp.leadId === toLeadId) {
      continue;
    }
    await ctx.db.patch("followUps", followUp._id, { leadId: toLeadId });
    result.followUps += 1;
  }

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "qualification_events", events);
  for (const event of events) {
    // Rebuild even when the event already names `toLeadId`: the row's
    // search text includes the opportunity's lead.
    if (await repointQualificationEvent(ctx, event, toLeadId)) {
      result.qualificationEvents += 1;
    }
  }

  const matches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_opportunityId", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "audit_matches", matches);
  for (const match of matches) {
    if (match.leadId === toLeadId) {
      continue;
    }
    await repointAuditMatch(ctx, match, toLeadId, now);
    result.auditMatches += 1;
  }

  return result;
}

// A meeting moves with every row keyed by it, or not at all.
function requireComplete(rows: unknown[], meetingId: Id<"meetings">, what: string) {
  if (rows.length > ROW_LIMIT) {
    throw new Error(`Meeting ${meetingId} has more than ${ROW_LIMIT} ${what} and can't move`);
  }
}

export type MeetingMoveResult = {
  formResponses: number;
  webhookDeliveries: number;
  reassignments: number;
};

/**
 * Moves one meeting to another opportunity, with the rows keyed by it: its
 * form responses, webhook receipts and reassignment history, which take the
 * new opportunity and its lead. `fields` sets the meeting fields that depend
 * on its opportunity, such as `callClassification`. The meeting's aggregates
 * and projection follow; the caller runs `updateOpportunityMeetingRefs` on
 * both opportunities after its last move.
 *
 * A payment names the meeting it was taken on, and stays on its own
 * opportunity, so a meeting with a payment doesn't move.
 */
export async function moveMeetingToOpportunity(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    toOpportunityId: Id<"opportunities">;
    /** The new lead's display name (`leadDisplayString`). */
    leadName: string;
    fields?: Partial<
      Pick<Doc<"meetings">, "callClassification" | "rescheduledFromMeetingId">
    >;
  },
): Promise<MeetingMoveResult> {
  const { tenantId, meetingId, toOpportunityId } = args;
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== tenantId) {
    throw new Error("Meeting not found");
  }
  const to = await ctx.db.get("opportunities", toOpportunityId);
  if (!to || to.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  if (meeting.opportunityId !== toOpportunityId) {
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) =>
        q.eq("opportunityId", meeting.opportunityId),
      )
      .take(ROW_LIMIT + 1);
    // Payments have no meeting index, so a partial read could miss one.
    requireComplete(payments, meetingId, "payments on its opportunity");
    if (payments.some((payment) => payment.meetingId === meetingId)) {
      throw new Error(`Meeting ${meetingId} has a payment and can't move`);
    }
  }

  await ctx.db.patch("meetings", meetingId, {
    opportunityId: toOpportunityId,
    leadName: args.leadName,
    ...args.fields,
  });
  // Also mirrors the new opportunity's status onto the meeting.
  await replaceMeetingAggregate(ctx, meeting, meetingId);

  const result: MeetingMoveResult = {
    formResponses: 0,
    webhookDeliveries: 0,
    reassignments: 0,
  };
  const responses = await ctx.db
    .query("meetingFormResponses")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .take(ROW_LIMIT + 1);
  requireComplete(responses, meetingId, "form responses");
  for (const response of responses) {
    if (response.opportunityId === toOpportunityId && response.leadId === to.leadId) {
      continue;
    }
    await ctx.db.patch("meetingFormResponses", response._id, {
      opportunityId: toOpportunityId,
      leadId: to.leadId,
    });
    result.formResponses += 1;
  }

  const deliveries = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_inviteeUri_and_status", (q) =>
      q.eq("tenantId", tenantId).eq("inviteeUri", meeting.calendlyInviteeUri),
    )
    .take(ROW_LIMIT + 1);
  requireComplete(deliveries, meetingId, "webhook receipts");
  for (const delivery of deliveries) {
    if (delivery.meetingId !== meetingId) {
      continue;
    }
    if (delivery.opportunityId === toOpportunityId && delivery.leadId === to.leadId) {
      continue;
    }
    await ctx.db.patch("webhookDeliveries", delivery._id, {
      opportunityId: toOpportunityId,
      leadId: to.leadId,
    });
    result.webhookDeliveries += 1;
  }

  const reassignments = await ctx.db
    .query("meetingReassignments")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .take(ROW_LIMIT + 1);
  requireComplete(reassignments, meetingId, "reassignments");
  for (const reassignment of reassignments) {
    if (reassignment.opportunityId === toOpportunityId) {
      continue;
    }
    await ctx.db.patch("meetingReassignments", reassignment._id, {
      opportunityId: toOpportunityId,
    });
    result.reassignments += 1;
  }
  return result;
}

/**
 * Moves every remaining row in a lead-indexed table from `fromLeadId` to
 * `toLeadId`: lead notes, the DM portal's edit history, Slack qualification
 * events (with their operations rows), lead gen audit matches, and
 * follow-ups. Form responses move with `moveFormResponsesPage`.
 */
export async function moveRemainingLeadRows(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    fromLeadId: Id<"leads">;
    toLeadId: Id<"leads">;
    now: number;
  },
): Promise<LeadRowsMoveResult> {
  const { tenantId, fromLeadId, toLeadId, now } = args;
  const result: LeadRowsMoveResult = {
    notes: 0,
    portalEdits: 0,
    followUps: 0,
    qualificationEvents: 0,
    auditMatches: 0,
    prospects: 0,
    copyEvents: 0,
    hasMoreTouches: false,
    boundsHit: [],
  };

  const notes = await ctx.db
    .query("leadNotes")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "notes", notes);
  for (const note of notes) {
    await ctx.db.patch("leadNotes", note._id, { leadId: toLeadId });
  }
  result.notes = notes.length;

  // The edit history follows the person it describes.
  const portalEdits = await ctx.db
    .query("linkPortalLeadEdits")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "portal_edits", portalEdits);
  for (const edit of portalEdits) {
    await ctx.db.patch("linkPortalLeadEdits", edit._id, { leadId: toLeadId });
  }
  result.portalEdits = portalEdits.length;

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "qualification_events", events);
  for (const event of events) {
    await repointQualificationEvent(ctx, event, toLeadId);
  }
  result.qualificationEvents = events.length;

  const matches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "audit_matches", matches);
  for (const match of matches) {
    await repointAuditMatch(ctx, match, toLeadId, now);
  }
  result.auditMatches = matches.length;

  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(ROW_LIMIT);
  noteBound(result.boundsHit, "follow_ups", followUps);
  for (const followUp of followUps) {
    await ctx.db.patch("followUps", followUp._id, { leadId: toLeadId });
  }
  result.followUps = followUps.length;

  // Lead gen prospects and DM portal copies are the person's touches
  // (docs/plans/phase-2-person-first.md §5). A person can have more than one
  // page of them, so the caller continues while `hasMoreTouches` is set.
  const touches = await moveTouchRowsPage(ctx, {
    tenantId,
    fromLeadId,
    toLeadId,
    now,
    limit: ROW_LIMIT,
  });
  result.prospects = touches.prospects;
  result.copyEvents = touches.copyEvents;
  result.hasMoreTouches = touches.hasMore;

  return result;
}

/**
 * Moves up to `limit` lead gen prospects and up to `limit` DM portal copy
 * events from `fromLeadId` to `toLeadId`. `hasMore` is true when either page
 * was full, so the caller runs another page.
 */
export async function moveTouchRowsPage(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    fromLeadId: Id<"leads">;
    toLeadId: Id<"leads">;
    now: number;
    limit: number;
  },
): Promise<{ prospects: number; copyEvents: number; hasMore: boolean }> {
  const { tenantId, fromLeadId, toLeadId, now, limit } = args;
  const prospects = await ctx.db
    .query("leadGenProspects")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(limit);
  const toLead = prospects.length > 0 ? await ctx.db.get("leads", toLeadId) : null;
  for (const prospect of prospects) {
    await ctx.db.patch("leadGenProspects", prospect._id, { leadId: toLeadId, updatedAt: now });
    // The prospect now counts toward the target's stages.
    await syncProspectConversions(ctx, { ...prospect, leadId: toLeadId, updatedAt: now }, toLead);
  }
  const copyEvents = await ctx.db
    .query("linkPortalCopyEvents")
    .withIndex("by_tenantId_and_leadId_and_copiedAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", fromLeadId),
    )
    .take(limit);
  for (const copyEvent of copyEvents) {
    await ctx.db.patch("linkPortalCopyEvents", copyEvent._id, { leadId: toLeadId });
  }
  return {
    prospects: prospects.length,
    copyEvents: copyEvents.length,
    hasMore: prospects.length === limit || copyEvents.length === limit,
  };
}

/**
 * Moves up to `limit` form responses from `fromLeadId` to `toLeadId`.
 * `hasMore` is true when the page was full, so the caller runs another page.
 */
export async function moveFormResponsesPage(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    fromLeadId: Id<"leads">;
    toLeadId: Id<"leads">;
    limit: number;
  },
): Promise<{ moved: number; hasMore: boolean }> {
  const responses = await ctx.db
    .query("meetingFormResponses")
    .withIndex("by_leadId", (q) => q.eq("leadId", args.fromLeadId))
    .take(args.limit);
  for (const response of responses) {
    if (response.tenantId !== args.tenantId) {
      throw new Error("Form response tenant mismatch");
    }
    await ctx.db.patch("meetingFormResponses", response._id, {
      leadId: args.toLeadId,
    });
  }
  return { moved: responses.length, hasMore: responses.length === args.limit };
}

/**
 * Points a Slack qualification event at `toLeadId` and rebuilds its
 * operations row, which copies the event's lead. Returns whether the event
 * moved.
 */
export async function repointQualificationEvent(
  ctx: MutationCtx,
  event: Doc<"slackQualificationEvents">,
  toLeadId: Id<"leads">,
): Promise<boolean> {
  const moved = event.leadId !== toLeadId;
  if (moved) {
    await ctx.db.patch("slackQualificationEvents", event._id, {
      leadId: toLeadId,
    });
  }
  await rebuildQualificationRow(ctx, event._id);
  return moved;
}

const MATCH_STATUS_RANK: Record<
  Doc<"leadGenAuditMatches">["matchStatus"],
  number
> = { accepted: 0, candidate: 1, rejected: 2 };

/**
 * Points a lead gen audit match at `toLeadId`, keeping one match per prospect
 * and lead. When that lead already has matches for the same prospect, the
 * best status survives (accepted, then candidate, then rejected; a tie keeps
 * the row already there) and the others are deleted. The prospect's current
 * match moves to the survivor.
 */
export async function repointAuditMatch(
  ctx: MutationCtx,
  match: Doc<"leadGenAuditMatches">,
  toLeadId: Id<"leads">,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_prospectId_and_leadId", (q) =>
      q
        .eq("tenantId", match.tenantId)
        .eq("prospectId", match.prospectId)
        .eq("leadId", toLeadId),
    )
    .take(5);
  const rows = [...existing, match];
  const survivor = rows.reduce((best, row) =>
    MATCH_STATUS_RANK[row.matchStatus] < MATCH_STATUS_RANK[best.matchStatus]
      ? row
      : best,
  );
  const losers = rows.filter((row) => row._id !== survivor._id);

  // An accepted match keeps the booked opportunity a deleted row had, as
  // matching does.
  const lostOpportunityId = losers.find(
    (row) => row.opportunityId !== undefined,
  )?.opportunityId;
  const keepsOpportunity =
    survivor.matchStatus === "accepted" &&
    survivor.opportunityId === undefined &&
    lostOpportunityId !== undefined;
  if (survivor._id === match._id || keepsOpportunity) {
    await ctx.db.patch("leadGenAuditMatches", survivor._id, {
      leadId: toLeadId,
      ...(keepsOpportunity ? { opportunityId: lostOpportunityId } : {}),
      updatedAt: now,
    });
  }
  if (losers.length === 0) {
    return;
  }

  const prospect = await ctx.db.get("leadGenProspects", match.prospectId);
  if (losers.some((row) => row._id === prospect?.currentAuditMatchId)) {
    await ctx.db.patch("leadGenProspects", match.prospectId, {
      currentAuditMatchId: survivor._id,
      updatedAt: now,
    });
  }
  for (const row of losers) {
    await ctx.db.delete("leadGenAuditMatches", row._id);
  }
}
