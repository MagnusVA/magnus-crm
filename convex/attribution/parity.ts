import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { bookingCreditsInWindow } from "../lib/attribution/dealAttributions";

// A read-only check that the attribution rows give Booked Calls the same
// numbers as the copied team and DM closer columns, before the readers move
// to the rows (docs/plans/phase-3-attribution.md §10.4). The show-rate
// filter's check ran before its readers moved, and went with the copies in
// the meeting stats buckets. For production:
// npx convex run attribution/parity:compareBookedCalls '{"tenantId":"…","start":…,"end":…}'

// About two months of bookings; past it the report says `capped`.
const BOOKED_CALLS_MEETING_CAP = 3000;

function increment<K>(counts: Map<K, number>, key: K) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function differences<K extends string>(copies: Map<K, number>, rows: Map<K, number>) {
  return [...new Set([...copies.keys(), ...rows.keys()])]
    .sort()
    .map((key) => ({ key, copies: copies.get(key) ?? 0, rows: rows.get(key) ?? 0 }))
    .filter((count) => count.copies !== count.rows);
}

function sum(counts: Map<unknown, number>) {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/**
 * Booked Calls both ways over bookings made in [start, end): the DM closer
 * counts and team progress Booked Calls shows today (first bookings that name
 * a DM closer), and team progress with the team-only bookings (D9).
 */
export const compareBookedCalls = internalQuery({
  args: { tenantId: v.id("tenants"), start: v.number(), end: v.number() },
  returns: v.object({
    dmCloserDiffs: v.array(
      v.object({ dmCloserId: v.id("dmClosers"), copies: v.number(), rows: v.number() }),
    ),
    teamDiffs: v.array(
      v.object({ teamId: v.id("attributionTeams"), copies: v.number(), rows: v.number() }),
    ),
    teamOnlyByTeam: v.array(
      v.object({
        teamId: v.id("attributionTeams"),
        withDmCloser: v.number(),
        teamOnly: v.number(),
        total: v.number(),
      }),
    ),
    totals: v.object({
      meetings: v.number(),
      firstBookings: v.number(),
      copies: v.object({ dmCloserBooked: v.number(), teamBooked: v.number() }),
      rows: v.object({
        dmCloserBooked: v.number(),
        teamBooked: v.number(),
        teamBookedWithTeamOnly: v.number(),
      }),
    }),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.start) || !Number.isFinite(args.end) || args.start >= args.end) {
      throw new Error("start must be a time before end");
    }
    const scan = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q.eq("tenantId", args.tenantId).gte("createdAt", args.start).lt("createdAt", args.end),
      )
      .take(BOOKED_CALLS_MEETING_CAP + 1);
    const meetings = scan.slice(0, BOOKED_CALLS_MEETING_CAP);
    const firstBookings = meetings.filter((meeting) => meeting.callClassification !== "follow_up");
    const { credits, capped: rowsCapped } = await bookingCreditsInWindow(ctx, {
      tenantId: args.tenantId,
      start: args.start,
      end: args.end,
      maxRowsPerRole: BOOKED_CALLS_MEETING_CAP,
    });

    const copies = { dmCloser: new Map<Id<"dmClosers">, number>(), team: new Map<Id<"attributionTeams">, number>() };
    const rows = {
      dmCloser: new Map<Id<"dmClosers">, number>(),
      team: new Map<Id<"attributionTeams">, number>(),
      teamOnly: new Map<Id<"attributionTeams">, number>(),
    };
    for (const meeting of firstBookings) {
      if (meeting.dmCloserId) {
        increment(copies.dmCloser, meeting.dmCloserId);
        if (meeting.attributionTeamId) increment(copies.team, meeting.attributionTeamId);
      }
      const credit = credits.get(meeting._id);
      if (credit?.dmCloserId) {
        increment(rows.dmCloser, credit.dmCloserId);
        if (credit.teamId) increment(rows.team, credit.teamId);
      } else if (credit?.teamId) {
        increment(rows.teamOnly, credit.teamId);
      }
    }

    const teamIds = [...new Set([...rows.team.keys(), ...rows.teamOnly.keys()])].sort();
    return {
      dmCloserDiffs: differences(copies.dmCloser, rows.dmCloser).map(({ key, ...count }) => ({
        dmCloserId: key,
        ...count,
      })),
      teamDiffs: differences(copies.team, rows.team).map(({ key, ...count }) => ({ teamId: key, ...count })),
      teamOnlyByTeam: teamIds.map((teamId) => {
        const withDmCloser = rows.team.get(teamId) ?? 0;
        const teamOnly = rows.teamOnly.get(teamId) ?? 0;
        return { teamId, withDmCloser, teamOnly, total: withDmCloser + teamOnly };
      }),
      totals: {
        meetings: meetings.length,
        firstBookings: firstBookings.length,
        copies: { dmCloserBooked: sum(copies.dmCloser), teamBooked: sum(copies.team) },
        rows: {
          dmCloserBooked: sum(rows.dmCloser),
          teamBooked: sum(rows.team),
          teamBookedWithTeamOnly: sum(rows.team) + sum(rows.teamOnly),
        },
      },
      capped: scan.length > BOOKED_CALLS_MEETING_CAP || rowsCapped,
    };
  },
});
