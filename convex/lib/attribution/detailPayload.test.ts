/**
 * The DM attribution a meeting, deal or person page shows, from the
 * attribution rows (docs/plans/phase-3-attribution.md §6.5): a resolved
 * meeting shows its own booking's, anything else the deal's first booking's.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { bookingHarness } from "../../../tests/bookingHarness";
import {
  seedCreditedDeal,
  seedScenario,
  type ScenarioName,
} from "../../../tests/detailAttributionFixtures";
import { buildOpportunityAttributionPayload, resolveTouches } from "./detailPayload";

const dmCloserIdentity = (id: Id<"dmClosers">) => ({
  id,
  name: "Dana DM",
  email: null,
  imageUrl: null,
  imageSource: "none",
  secondaryLabel: null,
  isActive: true,
  source: "dm_closer",
});

const NONE = {
  status: "none",
  teamName: null,
  dmCloserName: null,
  dmCloser: null,
  rawSource: null,
  rawMedium: null,
};

async function dmAttributionOf(
  scenario: ScenarioName,
  options: { copies: boolean; view: "meeting" | "deal" },
) {
  const h = await bookingHarness();
  return await h.t.run(async (ctx) => {
    const seeded = await seedScenario(ctx, h.tenantId, scenario, options);
    const opportunity = (await ctx.db.get("opportunities", seeded.opportunityId))!;
    const meeting =
      options.view === "meeting" && seeded.meetingId
        ? await ctx.db.get("meetings", seeded.meetingId)
        : null;
    const payload = await buildOpportunityAttributionPayload(ctx, opportunity, { meeting });
    return { dmAttribution: payload.dmAttribution, dmCloserId: seeded.dm.dmCloserId };
  });
}

describe.each([
  { copies: true, label: "with the copied columns beside the rows" },
  { copies: false, label: "from the rows alone" },
])("dmAttribution $label", ({ copies }) => {
  it("shows a booking through a team and a DM closer", async () => {
    for (const view of ["meeting", "deal"] as const) {
      const { dmAttribution, dmCloserId } = await dmAttributionOf("team_and_dm_closer", { copies, view });
      expect(dmAttribution).toEqual({
        status: "mapped",
        teamName: "Alpha Team",
        dmCloserName: "Dana DM",
        dmCloser: dmCloserIdentity(dmCloserId),
        rawSource: "alpha",
        rawMedium: "dana",
      });
    }
  });

  it("shows a team-only booking with its team and no DM closer", async () => {
    const { dmAttribution } = await dmAttributionOf("team_only", { copies, view: "meeting" });
    expect(dmAttribution).toEqual({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: null,
      dmCloser: null,
      rawSource: "alpha",
      rawMedium: null,
    });
  });

  it("falls back to the deal's first booking for a meeting that was never resolved", async () => {
    const { dmAttribution, dmCloserId } = await dmAttributionOf("unresolved_rebook", { copies, view: "meeting" });
    expect(dmAttribution).toEqual({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: dmCloserIdentity(dmCloserId),
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });

  it("shows an internal rebook as internal, and its deal as its first booking", async () => {
    const meeting = await dmAttributionOf("internal_rebook", { copies, view: "meeting" });
    expect(meeting.dmAttribution).toEqual({
      ...NONE,
      status: "internal",
      rawSource: "ptdom",
    });
    const deal = await dmAttributionOf("internal_rebook", { copies, view: "deal" });
    expect(deal.dmAttribution).toEqual({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: dmCloserIdentity(deal.dmCloserId),
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });

  it("shows nothing for a deal no booking has reached", async () => {
    const { dmAttribution } = await dmAttributionOf("no_bookings", { copies, view: "deal" });
    expect(dmAttribution).toEqual(NONE);
  });
});

async function creditedDealPayload() {
  const h = await bookingHarness();
  return await h.t.run(async (ctx) => {
    const seeded = await seedCreditedDeal(ctx, h.tenantId);
    const opportunity = (await ctx.db.get("opportunities", seeded.opportunityId))!;
    return { seeded, payload: await buildOpportunityAttributionPayload(ctx, opportunity) };
  });
}

describe("credits and touches", () => {
  it("lists every row on the deal by role then time, with who or which team", async () => {
    const { payload, seeded } = await creditedDealPayload();
    const m1 = seeded.first.meeting;
    const m2 = seeded.rebook.meeting;

    expect(
      payload.credits.map(({ role, name, sourceKind, meetingId, attributedAt }) => ({
        role, name, sourceKind, meetingId, attributedAt,
      })),
    ).toEqual([
      { role: "lead_gen", name: "Wendy Worker", sourceKind: "capture", meetingId: null, attributedAt: seeded.capturedAt },
      { role: "setter", name: "Sam Setter", sourceKind: "slack_qualification", meetingId: null, attributedAt: seeded.qualifiedAt },
      { role: "dm_team", name: "Alpha Team", sourceKind: "booking_utm", meetingId: m1._id, attributedAt: m1.createdAt },
      { role: "dm_team", name: "Alpha Team", sourceKind: "booking_utm", meetingId: m2._id, attributedAt: m2.createdAt },
      { role: "dm_closer", name: "Dana DM", sourceKind: "booking_utm", meetingId: m1._id, attributedAt: m1.createdAt },
      { role: "dm_closer", name: "Dirk DM", sourceKind: "booking_utm", meetingId: m2._id, attributedAt: m2.createdAt },
      { role: "closer", name: "closer@example.com", sourceKind: "booking_closer", meetingId: m1._id, attributedAt: m1.createdAt },
      { role: "closer", name: "closer@example.com", sourceKind: "booking_closer", meetingId: m2._id, attributedAt: m2.createdAt },
    ]);

    const byRole = (role: string) => payload.credits.find((credit) => credit.role === role)!;
    // The name is the team member's; the avatar is their login's, Slack user's or DM closer's.
    expect(byRole("lead_gen").identity).toMatchObject({
      name: "Wendy Worker", source: "crm_user", email: "wendy@example.com",
    });
    expect(byRole("setter").identity).toMatchObject({
      name: "Sam Setter", source: "slack", imageUrl: "https://example.com/sam.png",
    });
    expect(byRole("dm_team").identity).toBeNull();
    expect(byRole("dm_closer").identity).toMatchObject({
      id: seeded.dana.dmCloserId, name: "Dana DM", source: "dm_closer",
    });
    expect(byRole("closer").identity).toMatchObject({ id: seeded.closer._id, source: "crm_user" });
  });

  it("shows the deal's first and latest touch with who made each", async () => {
    const { payload, seeded } = await creditedDealPayload();

    expect(payload.firstTouch).toMatchObject({
      eventId: seeded.captureEventId,
      eventType: "lead.captured",
      channel: "lead_gen",
      occurredAt: seeded.capturedAt,
      teamMemberName: "Wendy Worker",
      teamMember: { name: "Wendy Worker", source: "crm_user" },
    });
    // The deal copied its person's touches when it was created, before any booking.
    expect(payload.latestTouch).toMatchObject({
      eventId: seeded.dealEventId,
      eventType: "opportunity.created",
      channel: "slack",
      occurredAt: seeded.qualifiedAt,
      teamMemberName: "Sam Setter",
      teamMember: { source: "slack" },
    });
  });

  it("credits a Calendly touch to its booking's DM closer, and nobody on a team-only booking", async () => {
    const h = await bookingHarness();
    const touches = await h.t.run(async (ctx) => {
      const credited = await seedCreditedDeal(ctx, h.tenantId);
      const teamOnly = await seedScenario(ctx, h.tenantId, "team_only", { copies: true });
      const teamOnlyEvent = (await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", h.tenantId).eq("entityType", "meeting").eq("entityId", teamOnly.meetingId!),
        )
        .unique())!;
      const calendlyTouch = (eventId: Id<"domainEvents">, occurredAt: number) => ({
        eventId, eventType: "meeting.created", channel: "calendly" as const, occurredAt,
      });
      return await resolveTouches(ctx, {
        tenantId: h.tenantId,
        firstTouch: calendlyTouch(credited.rebook.eventId, credited.rebook.meeting.createdAt),
        latestTouch: calendlyTouch(teamOnlyEvent._id, teamOnlyEvent.occurredAt),
      });
    });

    expect(touches.firstTouch).toMatchObject({ channel: "calendly", teamMemberName: "Dirk DM" });
    expect(touches.latestTouch).toMatchObject({
      channel: "calendly", teamMemberName: null, teamMember: null,
    });
  });

  it("has no credits or touches on a deal with none", async () => {
    const h = await bookingHarness();
    const payload = await h.t.run(async (ctx) => {
      const seeded = await seedScenario(ctx, h.tenantId, "no_bookings", { copies: false });
      const opportunity = (await ctx.db.get("opportunities", seeded.opportunityId))!;
      return await buildOpportunityAttributionPayload(ctx, opportunity);
    });
    expect(payload).toMatchObject({ credits: [], firstTouch: null, latestTouch: null });
  });
});
