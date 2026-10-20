import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { TOP_DM_CLOSER_BOOKING_LIMIT } from "../leadGen/reportLimits";
import {
  BOOKED_CALLS_RANGE,
  BOOKED_CALLS_WINDOW,
  seedBookedCallsFixture,
  type BookedCallsCopies,
} from "../../tests/bookedCallsFixture";
import {
  buildDmCloserEfficiencyRows,
  buildExpandedOverviewLeaderboard,
} from "./overviewLeaderboardBuilders";
import { getTopDmClosersOverviewSection } from "./overviewOperations";
import { deriveOverviewRange } from "./overviewRange";

const range = deriveOverviewRange(BOOKED_CALLS_RANGE, BOOKED_CALLS_WINDOW.end + 86_400_000);

async function setup(copies: BookedCallsCopies) {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => await seedBookedCallsFixture(ctx, { copies }));
  return { t, fixture };
}

describe.each(["pipeline", "none"] as const)("DM closer leaderboard with copies: %s", (copies) => {
  it("credits first bookings by DM closer record and by team from the rows", async () => {
    const { t, fixture } = await setup(copies);
    const result = await t.run(async (ctx) => {
      const built = await buildDmCloserEfficiencyRows(ctx, {
        tenantId: fixture.tenantId,
        range,
        includeAllCandidates: false,
      });
      return {
        truncated: built.truncated,
        booked: Object.fromEntries(built.rows.map((row) => [row.dmCloserId, row.booked])),
        bookedByTeam: Object.fromEntries(built.bookedByTeam),
        teamOnlyBooked: built.teamOnlyBooked,
      };
    });

    expect(result.truncated).toBe(false);
    expect(result.booked).toEqual({
      [fixture.dmClosers.northA]: 1,
      [fixture.dmClosers.northA2]: 1,
      [fixture.dmClosers.northB]: 1,
      [fixture.dmClosers.southC]: 0,
    });
    // South's only first booking named no DM closer; it still counts for South.
    expect(result.bookedByTeam).toEqual({
      [fixture.teams.north]: 3,
      [fixture.teams.south]: 1,
    });
    expect(result.teamOnlyBooked).toBe(1);
  });

  it("shows the same counts in the Overview's Top DM Closers", async () => {
    const { t, fixture } = await setup(copies);
    const { section, expanded } = await t.run(async (ctx) => ({
      section: await getTopDmClosersOverviewSection(ctx, fixture.tenantId, range),
      expanded: await buildExpandedOverviewLeaderboard(ctx, {
        tenantId: fixture.tenantId,
        kind: "dm_closers",
        range,
        filters: { activity: "with_activity" },
      }),
    }));

    expect(section.truncated).toBe(false);
    expect(section.data.totalBooked).toBe(3);
    expect(
      Object.fromEntries(section.data.rows.map((row) => [row.displayName, row.booked])),
    ).toEqual({
      "Avery North": 1,
      "Avery North Second": 1,
      "Blake North": 1,
      "Casey South": 0,
    });
    if (expanded.kind !== "dm_closers") throw new Error("Expected the DM closer leaderboard.");
    expect(expanded.rows.map((row) => row.dmCloserId).sort()).toEqual(
      [fixture.dmClosers.northA, fixture.dmClosers.northA2, fixture.dmClosers.northB].sort(),
    );
  });
});

it("is truncated when the booking rows read is capped, like a capped meetings read", async () => {
  const { t, fixture } = await setup("none");
  const result = await t.run(async (ctx) => {
    const opportunityId = (await ctx.db.get("meetings", fixture.meetings.firstNorthA))!.opportunityId;
    for (let index = 0; index <= TOP_DM_CLOSER_BOOKING_LIMIT; index += 1) {
      await ctx.db.insert("dealAttributions", {
        tenantId: fixture.tenantId,
        opportunityId,
        role: "dm_closer",
        source: { kind: "booking_utm", dmCloserId: fixture.dmClosers.northB },
        attributedAt: BOOKED_CALLS_WINDOW.start + index,
        createdAt: BOOKED_CALLS_WINDOW.start,
      });
    }
    const built = await buildDmCloserEfficiencyRows(ctx, {
      tenantId: fixture.tenantId,
      range,
      includeAllCandidates: false,
    });
    return {
      truncated: built.truncated,
      rows: built.rows.length,
      teams: built.bookedByTeam.size,
      teamOnlyBooked: built.teamOnlyBooked,
    };
  });

  expect(result).toEqual({ truncated: true, rows: 0, teams: 0, teamOnlyBooked: 0 });
});
