import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { bookingCreditsInWindow } from "../lib/attribution/dealAttributions";

// Read-only checks that the attribution rows give two reports the same
// numbers as the copied team and DM closer columns, before the readers move
// to the rows (docs/plans/phase-3-attribution.md §10.4). For production:
// npx convex run attribution/parity:compareBookedCalls '{"tenantId":"…","start":…,"end":…}'
// npx convex run attribution/parity:compareShowRateFilter '{"tenantId":"…","startDayKey":"2026-08-01","endDayKeyExclusive":"2026-09-01","teamId":"…"}'

// About two months of bookings; past it the report says `capped`.
const BOOKED_CALLS_MEETING_CAP = 3000;
// The show-rate readers' bucket cap.
const SHOW_RATE_BUCKET_CAP = 8192;
const SHOW_RATE_ROW_CAP = 2000;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

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

const statusCountsValidator = v.object({
  total: v.number(),
  scheduled: v.number(),
  completed: v.number(),
  canceled: v.number(),
  noShow: v.number(),
});
type StatusCounts = Infer<typeof statusCountsValidator>;
type MeetingStatus = Doc<"meetings">["status"];

function emptyCounts(): StatusCounts {
  return { total: 0, scheduled: 0, completed: 0, canceled: 0, noShow: 0 };
}

function addStatus(counts: StatusCounts, status: MeetingStatus, count: number) {
  counts.total += count;
  if (status === "no_show") counts.noShow += count;
  else counts[status] += count;
}

/**
 * The show-rate reports' team or DM closer filter both ways over scheduled
 * days [startDayKey, endDayKeyExclusive) in UTC: today's meeting stats
 * buckets, and the filter's dm_team or dm_closer rows with each meeting's
 * projected status (§6.4).
 */
export const compareShowRateFilter = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    startDayKey: v.string(),
    endDayKeyExclusive: v.string(),
    teamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  returns: v.object({
    copies: statusCountsValidator,
    rows: statusCountsValidator,
    matches: v.boolean(),
    // Rows whose meeting has no projected contribution, which no bucket counts.
    unprojectedRows: v.number(),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if ((args.teamId === undefined) === (args.dmCloserId === undefined)) {
      throw new Error("Pass exactly one of teamId and dmCloserId");
    }
    const start = Date.parse(args.startDayKey);
    const end = Date.parse(args.endDayKeyExclusive);
    if (!DAY_KEY.test(args.startDayKey) || !DAY_KEY.test(args.endDayKeyExclusive) || !(start < end)) {
      throw new Error("Day keys must be YYYY-MM-DD with start before end");
    }

    const buckets = await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive),
      )
      .take(SHOW_RATE_BUCKET_CAP + 1);
    const copies = emptyCounts();
    for (const bucket of buckets.slice(0, SHOW_RATE_BUCKET_CAP)) {
      if (args.teamId && bucket.attributionTeamId !== args.teamId) continue;
      if (args.dmCloserId && bucket.dmCloserId !== args.dmCloserId) continue;
      addStatus(copies, bucket.meetingStatus, bucket.count);
    }

    const { teamId, dmCloserId } = args;
    let scanned: Doc<"dealAttributions">[];
    if (teamId) {
      scanned = await ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_role_and_teamId_and_meetingScheduledAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("role", "dm_team")
            .eq("teamId", teamId)
            .gte("meetingScheduledAt", start)
            .lt("meetingScheduledAt", end),
        )
        .take(SHOW_RATE_ROW_CAP + 1);
    } else if (dmCloserId) {
      const dmCloser = await ctx.db.get("dmClosers", dmCloserId);
      if (!dmCloser || dmCloser.tenantId !== args.tenantId) throw new Error("DM closer not found");
      const teamMemberId = dmCloser.teamMemberId;
      scanned = teamMemberId
        ? await ctx.db
            .query("dealAttributions")
            .withIndex("by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt", (q) =>
              q
                .eq("tenantId", args.tenantId)
                .eq("role", "dm_closer")
                .eq("teamMemberId", teamMemberId)
                .gte("meetingScheduledAt", start)
                .lt("meetingScheduledAt", end),
            )
            .take(SHOW_RATE_ROW_CAP + 1)
        : [];
    } else {
      scanned = [];
    }
    // One team member can hold two DM closer records; keep this one's.
    const attributions = scanned
      .slice(0, SHOW_RATE_ROW_CAP)
      .filter(
        (row) =>
          !dmCloserId || (row.source.kind === "booking_utm" && row.source.dmCloserId === dmCloserId),
      );

    const rows = emptyCounts();
    let unprojectedRows = 0;
    for (const { meetingId } of attributions) {
      // The buckets hold each meeting's last applied contribution.
      const projection = meetingId
        ? await ctx.db
            .query("meetingProjections")
            .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
            .first()
        : null;
      if (!projection?.contribution) {
        unprojectedRows += 1;
        continue;
      }
      addStatus(rows, projection.contribution.meetingStatus, 1);
    }

    return {
      copies,
      rows,
      matches: (Object.keys(copies) as (keyof StatusCounts)[]).every((key) => copies[key] === rows[key]),
      unprojectedRows,
      capped: buckets.length > SHOW_RATE_BUCKET_CAP || scanned.length > SHOW_RATE_ROW_CAP,
    };
  },
});
