import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { recordBookingAttribution } from "../convex/lib/attribution/dealAttributions";
import type { UtmParams } from "../convex/lib/utmParams";

// Deals booked the way the Calendly pipeline books them: each meeting carries
// its resolved team and DM closer, writes its attribution rows, and the first
// external booking copies its resolution onto the deal.

type Resolution = NonNullable<Doc<"meetings">["attributionResolution"]>;

export type BookingFixture = {
  utmParams?: UtmParams;
  // Undefined for a booking that was never resolved.
  resolution?: Resolution;
  teamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
};

export async function insertAttributionTeam(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  name: string,
) {
  const slug = name.toLowerCase();
  return await ctx.db.insert("attributionTeams", {
    tenantId,
    slug,
    displayName: name,
    utmSource: slug,
    normalizedUtmSource: slug,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
  });
}

export async function insertDmCloser(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId: Id<"attributionTeams">;
    name: string;
    userId?: Id<"users">;
  },
) {
  const slug = args.name.toLowerCase();
  return await ctx.db.insert("dmClosers", {
    tenantId: args.tenantId,
    teamId: args.teamId,
    slug,
    displayName: args.name,
    utmMedium: slug,
    normalizedUtmMedium: slug,
    userId: args.userId,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
  });
}

/** Inserts one booking on a deal, with its rows and the first booking caches. */
export async function insertBooking(
  ctx: MutationCtx,
  args: {
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    key: string;
    scheduledAt: number;
    booking: BookingFixture;
  },
) {
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity) throw new Error("Fixture deal missing");
  const { booking } = args;
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: opportunity.tenantId,
    opportunityId: opportunity._id,
    assignedCloserId: args.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${args.key}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${args.key}/invitees/person`,
    scheduledAt: args.scheduledAt,
    durationMinutes: 30,
    status: "scheduled",
    createdAt: args.scheduledAt - 60_000,
    utmParams: booking.utmParams,
    attributionTeamId: booking.teamId,
    dmCloserId: booking.dmCloserId,
    attributionResolution: booking.resolution,
  });
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting) throw new Error("Fixture meeting missing");
  await recordBookingAttribution(ctx, {
    meeting,
    credit: { teamId: booking.teamId, dmCloserId: booking.dmCloserId },
  });

  // patchFirstExternalBookingCaches in pipeline/inviteeCreated.ts
  const internal = booking.utmParams?.utm_source === "ptdom";
  if (!internal && !opportunity.firstMeetingId) {
    await ctx.db.patch("opportunities", opportunity._id, {
      firstBookedAt: args.scheduledAt,
      firstMeetingId: meetingId,
      firstMeetingAt: args.scheduledAt,
      utmParams: booking.utmParams,
      attributionTeamId: booking.teamId,
      dmCloserId: booking.dmCloserId,
      attributionResolution: booking.resolution,
    });
  }
  return meetingId;
}

/**
 * Unsets the copied team and DM closer the way the clear after Phase 3 PR 6
 * does, so a reader that still reads them shows nothing. Meetings keep their
 * resolution; deals and qualification rows lose theirs.
 */
export async function clearAttributionCopies(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const cleared = { attributionTeamId: undefined, dmCloserId: undefined };
  for (const opportunity of await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(500)) {
    await ctx.db.patch("opportunities", opportunity._id, {
      ...cleared,
      attributionResolution: undefined,
    });
  }
  for (const meeting of await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
    .take(500)) {
    await ctx.db.patch("meetings", meeting._id, cleared);
  }
  for (const row of await ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_tenantId_and_qualifiedAt", (q) => q.eq("tenantId", tenantId))
    .take(500)) {
    // Required until PR 6 makes it optional; "none" is what an empty copy reads as.
    await ctx.db.patch("operationsQualificationRows", row._id, {
      ...cleared,
      attributionResolution: "none",
    });
  }
}
