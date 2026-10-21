import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { recordBookingAttribution } from "../convex/lib/attribution/dealAttributions";
import type { UtmParams } from "../convex/lib/utmParams";

// Deals booked the way the Calendly pipeline books them: each meeting keeps
// its resolution and writes its attribution rows for its resolved team and
// DM closer, and the first external booking sets the deal's first booking
// caches.

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
    });
  }
  return meetingId;
}
