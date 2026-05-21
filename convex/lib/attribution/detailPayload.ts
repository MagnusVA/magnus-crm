import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export type EntityAttributionPayload = {
  slackQualification: {
    slackUserId: string;
    slackUserLabel: string;
    submittedAt: number;
    resultKind: Doc<"slackQualificationEvents">["resultKind"];
  } | null;
  bookedProgram: { id: Id<"tenantPrograms">; name: string } | null;
  soldProgram: { id: Id<"tenantPrograms">; name: string } | null;
  dmAttribution: {
    status: "mapped" | "unmapped" | "internal" | "none";
    teamName: string | null;
    dmCloserName: string | null;
    rawSource: string | null;
    rawMedium: string | null;
  };
  phoneCloser: { id: Id<"users">; name: string } | null;
  timeline: {
    qualifiedAt: number | null;
    firstBookedAt: number | null;
    firstMeetingAt: number | null;
    paymentReceivedAt: number | null;
  };
};

function slackUserLabel(user: Doc<"slackUsers"> | null | undefined) {
  return (
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim() ||
    user?.slackUserId
  );
}

function userDisplayName(user: Doc<"users"> | null | undefined) {
  return user?.fullName?.trim() || user?.email || null;
}

async function resolveProgramSummary(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms"> | undefined,
  programName: string | undefined,
) {
  if (!programId) {
    return null;
  }

  if (programName) {
    return { id: programId, name: programName };
  }

  const program = await ctx.db.get(programId);
  if (!program || program.tenantId !== tenantId) {
    return null;
  }

  return { id: program._id, name: program.name };
}

export async function buildOpportunityAttributionPayload(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
  options?: { meeting?: Doc<"meetings"> | null },
): Promise<EntityAttributionPayload> {
  const meeting = options?.meeting ?? null;
  const useMeetingAttribution = meeting?.attributionResolution !== undefined;
  const rawUtmParams = useMeetingAttribution
    ? meeting.utmParams
    : meeting?.utmParams ?? opportunity.utmParams;
  const attributionTeamId = useMeetingAttribution
    ? meeting.attributionTeamId
    : meeting?.attributionTeamId ?? opportunity.attributionTeamId;
  const dmCloserId = useMeetingAttribution
    ? meeting.dmCloserId
    : meeting?.dmCloserId ?? opportunity.dmCloserId;
  const phoneCloserId = meeting?.assignedCloserId ?? opportunity.assignedCloserId;
  const bookedProgramId =
    meeting?.bookingProgramId ?? opportunity.firstBookingProgramId;
  const bookedProgramName =
    meeting?.bookingProgramName ?? opportunity.firstBookingProgramName;
  const soldProgramId = meeting?.soldProgramId ?? opportunity.soldProgramId;
  const soldProgramName = meeting?.soldProgramName ?? opportunity.soldProgramName;

  const [
    qualificationEvent,
    team,
    dmCloser,
    phoneCloser,
    bookedProgram,
    soldProgram,
  ] = await Promise.all([
    ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q
          .eq("tenantId", opportunity.tenantId)
          .eq("opportunityId", opportunity._id),
      )
      .order("desc")
      .first(),
    attributionTeamId ? ctx.db.get(attributionTeamId) : Promise.resolve(null),
    dmCloserId ? ctx.db.get(dmCloserId) : Promise.resolve(null),
    phoneCloserId ? ctx.db.get(phoneCloserId) : Promise.resolve(null),
    resolveProgramSummary(
      ctx,
      opportunity.tenantId,
      bookedProgramId,
      bookedProgramName,
    ),
    resolveProgramSummary(
      ctx,
      opportunity.tenantId,
      soldProgramId,
      soldProgramName,
    ),
  ]);

  const slackUser = qualificationEvent
    ? await ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId_and_slackUserId", (q) =>
          q
            .eq("tenantId", opportunity.tenantId)
            .eq("slackUserId", qualificationEvent.slackUserId),
        )
        .first()
    : null;

  return {
    slackQualification: qualificationEvent
      ? {
          slackUserId: qualificationEvent.slackUserId,
          slackUserLabel:
            slackUserLabel(slackUser) ?? qualificationEvent.slackUserId,
          submittedAt: qualificationEvent.submittedAt,
          resultKind: qualificationEvent.resultKind,
        }
      : null,
    bookedProgram,
    soldProgram,
    dmAttribution: {
      status:
        meeting?.attributionResolution ??
        opportunity.attributionResolution ??
        "none",
      teamName:
        team && team.tenantId === opportunity.tenantId ? team.displayName : null,
      dmCloserName:
        dmCloser && dmCloser.tenantId === opportunity.tenantId
          ? dmCloser.displayName
          : null,
      rawSource: rawUtmParams?.utm_source ?? null,
      rawMedium: rawUtmParams?.utm_medium ?? null,
    },
    phoneCloser:
      phoneCloser && phoneCloser.tenantId === opportunity.tenantId
        ? {
            id: phoneCloser._id,
            name: userDisplayName(phoneCloser) ?? "Unknown closer",
          }
        : null,
    timeline: {
      qualifiedAt:
        opportunity.qualifiedAt ?? opportunity.qualifiedBy?.submittedAt ?? null,
      firstBookedAt: opportunity.firstBookedAt ?? null,
      firstMeetingAt: opportunity.firstMeetingAt ?? meeting?.scheduledAt ?? null,
      paymentReceivedAt: opportunity.paymentReceivedAt ?? null,
    },
  };
}
