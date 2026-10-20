import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { TOP_DM_CLOSER_BOOKING_LIMIT } from "../leadGen/reportLimits";
import {
  BOOKED_CALLS_ADMIN,
  BOOKED_CALLS_RANGE,
  BOOKED_CALLS_WINDOW,
  seedBookedCallsFixture,
  type BookedCallsCopies,
} from "../../tests/bookedCallsFixture";

async function setup(copies: BookedCallsCopies) {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => await seedBookedCallsFixture(ctx, { copies }));
  return { t, fixture, admin: t.withIdentity(BOOKED_CALLS_ADMIN) };
}

type Admin = Awaited<ReturnType<typeof setup>>["admin"];

type DetailsPage = FunctionReturnType<
  typeof api.operations.bookedCallsDashboard.listBookedCallsDetails
>;

async function listAllDetails(admin: Admin, dmCloserId?: Id<"dmClosers">) {
  const rows: DetailsPage["page"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const result: DetailsPage = await admin.query(api.operations.bookedCallsDashboard.listBookedCallsDetails, {
      paginationOpts: { cursor, numItems: 2 },
      ...BOOKED_CALLS_WINDOW,
      ...(dmCloserId ? { dmCloserId } : {}),
    });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("listBookedCallsDetails never finished.");
}

// "pipeline" keeps the copied columns set the way the pipeline still writes
// them; "none" leaves only the rows. The numbers must not depend on the copies.
describe.each(["pipeline", "none"] as const)("Booked Calls with copies: %s", (copies) => {
  it("counts each DM closer record's first bookings, and the total, from the rows", async () => {
    const { fixture, admin } = await setup(copies);
    const dashboard = await admin.query(
      api.operations.bookedCallsDashboard.getBookedCallsDashboard,
      { range: BOOKED_CALLS_RANGE },
    );

    expect(dashboard.capped).toBe(false);
    expect(dashboard.window).toEqual(BOOKED_CALLS_WINDOW);
    const booked = Object.fromEntries(dashboard.dmClosers.map((row) => [row.key, row.booked]));
    // A and A2 are two records of one team member; each keeps its own count.
    // B's rebook is a follow-up and its other booking is outside the window.
    expect(booked).toEqual({
      [fixture.dmClosers.northA]: 1,
      [fixture.dmClosers.northA2]: 1,
      [fixture.dmClosers.northB]: 1,
      [fixture.dmClosers.southC]: 0,
    });
    expect(dashboard.totalBooked).toBe(3);
    expect(dashboard.dmClosers.find((row) => row.key === fixture.dmClosers.northA)).toMatchObject({
      label: "Avery North",
      teamLabel: "North Team",
      scheduledHours: 4,
      bookedPerHour: 0.25,
    });
  });

  it("counts a team-only first booking toward its team and the goal, not a DM closer (D9)", async () => {
    const { fixture, admin } = await setup(copies);
    const dashboard = await admin.query(
      api.operations.bookedCallsDashboard.getBookedCallsDashboard,
      { range: BOOKED_CALLS_RANGE },
    );

    expect(dashboard.goal.teams).toEqual([
      { teamId: fixture.teams.north, label: "North Team", dailyQuota: 2, target: 2, progress: 3 },
      { teamId: fixture.teams.south, label: "South Team", dailyQuota: 1, target: 1, progress: 1 },
    ]);
    expect(dashboard.goal.totalTarget).toBe(3);
    // Three DM-closer bookings and South's team-only booking.
    expect(dashboard.goal.progress).toBe(4);
    expect(dashboard.totalBooked).toBe(3);
    expect(
      dashboard.dmClosers.find((row) => row.key === fixture.dmClosers.southC)?.booked,
    ).toBe(0);
  });

  it("lists the DM closer's first bookings in the window with labels from the rows", async () => {
    const { fixture, admin } = await setup(copies);
    const rows = await listAllDetails(admin);

    expect(rows.map((row) => row.meetingId)).toEqual([
      fixture.meetings.legacyNorthB,
      fixture.meetings.firstNorthA2,
      fixture.meetings.firstNorthA,
    ]);
    expect(rows.find((row) => row.meetingId === fixture.meetings.firstNorthA)).toMatchObject({
      attributionTeamId: fixture.teams.north,
      attributionTeamLabel: "North Team",
      dmCloserId: fixture.dmClosers.northA,
      dmCloserLabel: "Avery North",
      leadLabel: "Alpha Prospect",
    });

    const second = await listAllDetails(admin, fixture.dmClosers.northA2);
    expect(second.map((row) => [row.meetingId, row.dmCloserLabel])).toEqual([
      [fixture.meetings.firstNorthA2, "Avery North Second"],
    ]);
    const blake = await listAllDetails(admin, fixture.dmClosers.northB);
    expect(blake.map((row) => row.meetingId)).toEqual([fixture.meetings.legacyNorthB]);
  });

  it("searches the same population, reading each deal's rows", async () => {
    const { fixture, admin } = await setup(copies);
    const search = async (searchTerm: string, dmCloserId?: Id<"dmClosers">) =>
      await admin.query(api.operations.bookedCallsDashboard.searchBookedCallsDetails, {
        searchTerm,
        ...BOOKED_CALLS_WINDOW,
        ...(dmCloserId ? { dmCloserId } : {}),
      });

    const all = await search("prospect");
    expect(all.map((row) => row.meetingId)).toEqual([
      fixture.meetings.legacyNorthB,
      fixture.meetings.firstNorthA2,
      fixture.meetings.firstNorthA,
    ]);
    expect(all.find((row) => row.meetingId === fixture.meetings.legacyNorthB)).toMatchObject({
      attributionTeamId: fixture.teams.north,
      attributionTeamLabel: "North Team",
      dmCloserId: fixture.dmClosers.northB,
      dmCloserLabel: "Blake North",
    });
    // Deal A's rebook went through Blake, but it is a follow-up.
    expect((await search("alpha", fixture.dmClosers.northB)).map((row) => row.meetingId)).toEqual([]);
    expect((await search("alpha", fixture.dmClosers.northA)).map((row) => row.meetingId)).toEqual([
      fixture.meetings.firstNorthA,
    ]);
    expect(await search("charlie")).toEqual([]);
  });
});

it("returns a capped dashboard when the booking rows read is capped", async () => {
  const { t, fixture, admin } = await setup("pipeline");
  await t.run(async (ctx) => {
    const opportunityId = (await ctx.db.get("meetings", fixture.meetings.firstNorthA))!.opportunityId;
    for (let index = 0; index <= TOP_DM_CLOSER_BOOKING_LIMIT; index += 1) {
      await ctx.db.insert("dealAttributions", {
        tenantId: fixture.tenantId,
        opportunityId,
        role: "dm_team",
        teamId: fixture.teams.north,
        source: { kind: "booking_utm" },
        attributedAt: BOOKED_CALLS_WINDOW.start + index,
        createdAt: BOOKED_CALLS_WINDOW.start,
      });
    }
  });

  const dashboard = await admin.query(
    api.operations.bookedCallsDashboard.getBookedCallsDashboard,
    { range: BOOKED_CALLS_RANGE },
  );
  expect(dashboard).toMatchObject({ capped: true, totalBooked: 0, dmClosers: [] });
});
