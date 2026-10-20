/**
 * The sales calls list labels each meeting with the DM team and DM closer of
 * its own booking's rows (docs/plans/phase-3-attribution.md §6.3), not the
 * copied columns.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import { recordBookingAttribution } from "../lib/attribution/dealAttributions";
import { enrichPhoneSalesRows } from "./phoneSales";

afterEach(() => vi.useRealTimers());

async function insertTeam(ctx: MutationCtx, tenantId: Id<"tenants">, slug: string) {
  return await ctx.db.insert("attributionTeams", {
    tenantId,
    slug,
    displayName: `Team ${slug}`,
    utmSource: slug,
    normalizedUtmSource: slug,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
  });
}

async function insertDmCloser(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  slug: string,
  teamId: Id<"attributionTeams">,
) {
  const teamMemberId = await ctx.db.insert("teamMembers", {
    tenantId,
    displayName: slug,
    createdAt: 0,
    updatedAt: 0,
  });
  return await ctx.db.insert("dmClosers", {
    tenantId,
    teamId,
    slug,
    displayName: `DM ${slug}`,
    utmMedium: slug,
    normalizedUtmMedium: slug,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    teamMemberId,
  });
}

it("labels each sales call from its own booking's rows", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  const { t, tenantId, admin } = await bookingHarness();
  const { meetingIds } = await t.run(async (ctx) => {
    const closerId = (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique())!._id;
    const t1 = await insertTeam(ctx, tenantId, "one");
    const t2 = await insertTeam(ctx, tenantId, "two");
    const d1 = await insertDmCloser(ctx, tenantId, "one", t1);
    const d2 = await insertDmCloser(ctx, tenantId, "two", t2);
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(0),
      status: "active",
      firstSeenAt: 0,
      updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "scheduled",
      source: "calendly",
      assignedCloserId: closerId,
      createdAt: 0,
      updatedAt: 0,
    });
    const meetingIds: Id<"meetings">[] = [];
    // The copies on each meeting say d1; the rows are what the booking credited.
    const bookings = [
      { at: "2026-10-01T12:00:00Z", credit: { teamId: t1, dmCloserId: d1 }, resolution: "mapped" as const },
      { at: "2026-10-02T12:00:00Z", credit: { teamId: t2, dmCloserId: d2 }, resolution: "mapped" as const },
      { at: "2026-10-03T12:00:00Z", credit: { teamId: t2 }, resolution: "mapped" as const },
      { at: "2026-10-03T13:00:00Z", credit: {}, resolution: "unmapped" as const },
    ];
    for (const [index, booking] of bookings.entries()) {
      const scheduledAt = Date.parse(booking.at);
      const meetingId = await ctx.db.insert("meetings", {
        tenantId,
        opportunityId,
        assignedCloserId: closerId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/label-${index}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/label-${index}/invitees/person`,
        scheduledAt,
        durationMinutes: 30,
        status: "scheduled",
        callClassification: index === 0 ? "new" : "follow_up",
        createdAt: scheduledAt - 3_600_000,
        attributionTeamId: t1,
        dmCloserId: d1,
        attributionResolution: booking.resolution,
      });
      await recordBookingAttribution(ctx, {
        meeting: (await ctx.db.get("meetings", meetingId))!,
        credit: booking.credit,
      });
      meetingIds.push(meetingId);
    }
    return { meetingIds };
  });

  const labels = await t.run(async (ctx) => {
    const meetings = await Promise.all(meetingIds.map(async (id) => (await ctx.db.get("meetings", id))!));
    return (await enrichPhoneSalesRows(ctx, meetings)).map((row) => ({
      attributionTeamName: row.attributionTeamName,
      dmCloserName: row.dmCloserName,
      dmCloser: row.dmCloser?.name ?? null,
      attributionResolution: row.attributionResolution,
    }));
  });
  expect(labels).toEqual([
    { attributionTeamName: "Team one", dmCloserName: "DM one", dmCloser: "DM one", attributionResolution: "mapped" },
    { attributionTeamName: "Team two", dmCloserName: "DM two", dmCloser: "DM two", attributionResolution: "mapped" },
    { attributionTeamName: "Team two", dmCloserName: null, dmCloser: null, attributionResolution: "mapped" },
    { attributionTeamName: null, dmCloserName: null, dmCloser: null, attributionResolution: "unmapped" },
  ]);

  // The list reads the newest meeting first; the follow-up keeps its own label.
  const page = await admin.query(api.operations.phoneSales.listPhoneSalesMeetings, {
    paginationOpts: { cursor: null, numItems: 1 },
    scheduledFrom: Date.parse("2026-10-02T00:00:00Z"),
    scheduledTo: Date.parse("2026-10-03T00:00:00Z"),
  });
  expect(page.page).toMatchObject([
    { meetingId: meetingIds[1], attributionTeamName: "Team two", dmCloserName: "DM two" },
  ]);
});
