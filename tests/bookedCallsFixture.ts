import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { recordBookingAttribution } from "../convex/lib/attribution/dealAttributions";
import { qualifiedLifecycle } from "./bookingHarness";

// One Honduras business day, a Friday: [2026-08-14T07:00Z, 2026-08-15T07:00Z).
export const BOOKED_CALLS_RANGE = {
  kind: "custom" as const,
  startBusinessDate: "2026-08-14",
  endBusinessDateInclusive: "2026-08-14",
};
export const BOOKED_CALLS_WINDOW = {
  start: Date.parse("2026-08-14T07:00:00.000Z"),
  end: Date.parse("2026-08-15T07:00:00.000Z"),
};
export const BOOKED_CALLS_ADMIN = {
  subject: "booked-calls-admin",
  org_id: "org_booked_calls",
};

function utc(day: string, hour: number) {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
}

type MeetingKey =
  | "firstNorthA"
  | "rebookNorthB"
  | "firstNorthA2"
  | "teamOnlySouth"
  | "noUtm"
  | "unmapped"
  | "outsideWindow"
  | "legacyNorthB";

export type BookedCallsFixture = {
  tenantId: Id<"tenants">;
  linkedUserId: Id<"users">;
  teams: { north: Id<"attributionTeams">; south: Id<"attributionTeams"> };
  dmClosers: {
    northA: Id<"dmClosers">;
    northA2: Id<"dmClosers">;
    northB: Id<"dmClosers">;
    southC: Id<"dmClosers">;
  };
  meetings: Record<MeetingKey, Id<"meetings">>;
};

/**
 * Booked Calls fixture. In the window (2026-08-14):
 *
 * | Meeting       | Deal | Kind      | Credit                         |
 * | ------------- | ---- | --------- | ------------------------------ |
 * | firstNorthA   | A    | new       | North, DM closer A             |
 * | rebookNorthB  | A    | follow_up | North, DM closer B (a rebook)  |
 * | firstNorthA2  | B    | new       | North, DM closer A2            |
 * | teamOnlySouth | C    | new       | South only                     |
 * | noUtm         | D    | new       | none (no UTMs)                 |
 * | unmapped      | E    | new       | none (UTMs matched no team)    |
 * | legacyNorthB  | G    | unset     | North, DM closer B             |
 *
 * and outsideWindow (deal F, 2026-08-13, North + DM closer B). DM closers A
 * and A2 are two records of one team member. DM closer C (South) has only a
 * schedule. Credit is only in each booking's `dealAttributions` rows.
 */
export async function seedBookedCallsFixture(ctx: MutationCtx): Promise<BookedCallsFixture> {
  const day = "2026-08-14";
  const now = utc(day, 12);
  const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
    companyName: "Booked calls",
    contactEmail: "booked-calls@example.invalid",
    workosOrgId: BOOKED_CALLS_ADMIN.org_id,
    status: "active",
    inviteExpiresAt: now + 60_000,
    createdBy: "test",
  });
  const adminId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: BOOKED_CALLS_ADMIN.subject,
    email: "booked-calls-admin@example.invalid",
    role: "tenant_admin",
    isActive: true,
  });
  const hostId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: "booked-calls-host",
    email: "booked-calls-host@example.invalid",
    fullName: "Calendly Host",
    role: "closer",
    isActive: true,
  });
  const linkedUserId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: "booked-calls-dm",
    email: "booked-calls-dm@example.invalid",
    fullName: "Avery Linked",
    profilePictureUrl: "https://example.invalid/avery-linked.png",
    role: "closer",
    isActive: true,
  });

  const team = async (slug: string, displayName: string, bookingDailyQuota: number) =>
    await ctx.db.insert("attributionTeams", {
      tenantId,
      slug,
      displayName,
      utmSource: slug,
      normalizedUtmSource: slug,
      isActive: true,
      bookingDailyQuota,
      createdAt: now,
      updatedAt: now,
    });
  const north = await team("north", "North Team", 2);
  const south = await team("south", "South Team", 1);

  const dmCloser = async (
    slug: string,
    displayName: string,
    teamId: Id<"attributionTeams">,
    userId?: Id<"users">,
  ) =>
    await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug,
      displayName,
      utmMedium: slug,
      normalizedUtmMedium: slug,
      ...(userId ? { userId } : {}),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  const northA = await dmCloser("avery-north", "Avery North", north, linkedUserId);
  const northA2 = await dmCloser("avery-north-2", "Avery North Second", north, linkedUserId);
  const northB = await dmCloser("blake-north", "Blake North", north);
  const southC = await dmCloser("casey-south", "Casey South", south);
  for (const [dmCloserId, scheduledHours] of [
    [northA, 4],
    [southC, 2],
  ] as const) {
    await ctx.db.insert("dmCloserSchedules", {
      tenantId,
      dmCloserId,
      weekday: "friday",
      scheduledHours,
      updatedByUserId: adminId,
      updatedAt: now,
    });
  }

  const deals = new Map<string, Id<"opportunities">>();
  const meetings = {} as Record<MeetingKey, Id<"meetings">>;
  const bookings: Array<{
    key: MeetingKey;
    deal: string;
    leadName: string;
    createdAt: number;
    callClassification: Doc<"meetings">["callClassification"];
    resolution: "mapped" | "unmapped" | "none";
    teamId?: Id<"attributionTeams">;
    dmCloserId?: Id<"dmClosers">;
  }> = [
    { key: "firstNorthA", deal: "A", leadName: "Alpha Prospect", createdAt: utc(day, 15), callClassification: "new", resolution: "mapped", teamId: north, dmCloserId: northA },
    { key: "rebookNorthB", deal: "A", leadName: "Alpha Prospect", createdAt: utc(day, 16), callClassification: "follow_up", resolution: "mapped", teamId: north, dmCloserId: northB },
    { key: "firstNorthA2", deal: "B", leadName: "Bravo Prospect", createdAt: utc(day, 17), callClassification: "new", resolution: "mapped", teamId: north, dmCloserId: northA2 },
    { key: "teamOnlySouth", deal: "C", leadName: "Charlie Prospect", createdAt: utc(day, 18), callClassification: "new", resolution: "mapped", teamId: south },
    { key: "noUtm", deal: "D", leadName: "Delta Prospect", createdAt: utc(day, 19), callClassification: "new", resolution: "none" },
    { key: "unmapped", deal: "E", leadName: "Echo Prospect", createdAt: utc(day, 20), callClassification: "new", resolution: "unmapped" },
    { key: "outsideWindow", deal: "F", leadName: "Foxtrot Prospect", createdAt: utc("2026-08-13", 18), callClassification: "new", resolution: "mapped", teamId: north, dmCloserId: northB },
    { key: "legacyNorthB", deal: "G", leadName: "Golf Prospect", createdAt: utc(day, 21), callClassification: undefined, resolution: "mapped", teamId: north, dmCloserId: northB },
  ];

  for (const booking of bookings) {
    let opportunityId = deals.get(booking.deal);
    if (!opportunityId) {
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(booking.createdAt),
        tenantId,
        fullName: booking.leadName,
        firstSeenAt: booking.createdAt,
        updatedAt: booking.createdAt,
        status: "active",
      });
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        stage: "booked", outcome: "open",
        assignedCloserId: hostId,
        createdAt: booking.createdAt,
        updatedAt: booking.createdAt,
      });
      await ctx.db.insert("opportunitySearch", {
        tenantId,
        opportunityId,
        leadId,
        assignedCloserId: hostId,
        source: "calendly",
        latestActivityAt: booking.createdAt,
        activityDayKey: day,
        activityWeekKey: "2026-W33",
        activityMonthKey: "2026-08",
        searchText: booking.leadName.toLowerCase(),
        updatedAt: booking.createdAt,
      });
      deals.set(booking.deal, opportunityId);
    }
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      assignedCloserId: hostId,
      calendlyEventUri: `https://example.invalid/event/${booking.key}`,
      calendlyInviteeUri: `https://example.invalid/invitee/${booking.key}`,
      scheduledAt: booking.createdAt + 86_400_000,
      durationMinutes: 30,
      status: "scheduled",
      ...(booking.callClassification ? { callClassification: booking.callClassification } : {}),
      leadName: booking.leadName,
      createdAt: booking.createdAt,
      attributionResolution: booking.resolution,
      attributionResolvedAt: booking.createdAt,
    });
    const meeting = await ctx.db.get("meetings", meetingId);
    await recordBookingAttribution(ctx, {
      meeting: meeting!,
      credit: { teamId: booking.teamId, dmCloserId: booking.dmCloserId },
    });
    meetings[booking.key] = meetingId;
  }

  return {
    tenantId,
    linkedUserId,
    teams: { north, south },
    dmClosers: { northA, northA2, northB, southC },
    meetings,
  };
}
