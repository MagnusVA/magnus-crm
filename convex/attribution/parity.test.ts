import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  attributionHarness,
  attributionRows,
  backfillAll,
  type AttributionHarness,
} from "../../tests/attributionFixtures";

afterEach(() => vi.useRealTimers());

const AUGUST = { start: Date.parse("2026-08-01T00:00:00Z"), end: Date.parse("2026-09-01T00:00:00Z") };

async function deleteRow(h: AttributionHarness, match: (row: Doc<"dealAttributions">) => boolean) {
  const row = (await attributionRows(h)).find(match);
  await h.t.run((ctx) => ctx.db.delete("dealAttributions", row!._id));
}

async function projectedHarness() {
  const h = await attributionHarness();
  await backfillAll(h);
  const projected = await h.run("rebuildMeetingProjections");
  if (projected?.error || !projected?.isDone) throw new Error(`rebuildMeetingProjections: ${projected?.error}`);
  return h;
}

describe("compareBookedCalls", () => {
  it("finds no difference after the backfill, and counts team-only bookings apart", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    const { tenantId, ids } = h;
    expect(await h.t.query(internal.attribution.parity.compareBookedCalls, { tenantId, ...AUGUST })).toEqual({
      dmCloserDiffs: [],
      teamDiffs: [],
      // The rebook through team B is a follow-up, so it counts nowhere.
      teamOnlyByTeam: [{ teamId: ids.teamA, withDmCloser: 1, teamOnly: 1, total: 2 }],
      totals: {
        meetings: 4,
        firstBookings: 3,
        copies: { dmCloserBooked: 1, teamBooked: 1 },
        rows: { dmCloserBooked: 1, teamBooked: 1, teamBookedWithTeamOnly: 2 },
      },
      capped: false,
    });
  });

  it("reports a booking whose rows lost its DM closer", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    const { tenantId, ids } = h;
    await deleteRow(h, (row) => row.meetingId === ids.meetings.m1 && row.role === "dm_closer");
    const report = await h.t.query(internal.attribution.parity.compareBookedCalls, { tenantId, ...AUGUST });
    expect(report.dmCloserDiffs).toEqual([{ dmCloserId: ids.dana, copies: 1, rows: 0 }]);
    expect(report.teamDiffs).toEqual([{ teamId: ids.teamA, copies: 1, rows: 0 }]);
    expect(report.teamOnlyByTeam).toEqual([{ teamId: ids.teamA, withDmCloser: 0, teamOnly: 2, total: 2 }]);
  });

  it("rejects an empty window", async () => {
    const h = await attributionHarness();
    await expect(
      h.t.query(internal.attribution.parity.compareBookedCalls, { tenantId: h.tenantId, start: 5, end: 5 }),
    ).rejects.toThrow("start");
  });
});

describe("compareShowRateFilter", () => {
  const august = { startDayKey: "2026-08-01", endDayKeyExclusive: "2026-09-01" };

  it("matches the meeting stats buckets for each team and DM closer", async () => {
    const h = await projectedHarness();
    const { tenantId, ids } = h;
    const compare = (filter: Record<string, unknown>) =>
      h.t.query(internal.attribution.parity.compareShowRateFilter, { tenantId, ...august, ...filter });

    expect(await compare({ teamId: ids.teamA })).toEqual({
      copies: { total: 2, scheduled: 1, completed: 1, canceled: 0, noShow: 0 },
      rows: { total: 2, scheduled: 1, completed: 1, canceled: 0, noShow: 0 },
      matches: true,
      unprojectedRows: 0,
      capped: false,
    });
    expect(await compare({ teamId: ids.teamB })).toMatchObject({ matches: true, rows: { total: 1, scheduled: 1 } });
    expect(await compare({ dmCloserId: ids.dana })).toMatchObject({ matches: true, rows: { total: 1, completed: 1 } });
    // The range is by scheduled day: the team-only call on the 16th falls out.
    expect(
      await h.t.query(internal.attribution.parity.compareShowRateFilter, {
        tenantId, startDayKey: "2026-08-01", endDayKeyExclusive: "2026-08-16", teamId: ids.teamA,
      }),
    ).toMatchObject({ matches: true, rows: { total: 1, completed: 1 } });
  });

  it("reports a team whose rows miss a booking", async () => {
    const h = await projectedHarness();
    const { tenantId, ids } = h;
    await deleteRow(h, (row) => row.meetingId === ids.meetings.m4 && row.role === "dm_team");
    expect(
      await h.t.query(internal.attribution.parity.compareShowRateFilter, { tenantId, ...august, teamId: ids.teamA }),
    ).toMatchObject({ matches: false, copies: { total: 2 }, rows: { total: 1 } });
  });

  it("takes exactly one of a team and a DM closer", async () => {
    const h = await attributionHarness();
    const { tenantId, ids } = h;
    for (const filter of [{}, { teamId: ids.teamA, dmCloserId: ids.dana }]) {
      await expect(
        h.t.query(internal.attribution.parity.compareShowRateFilter, { tenantId, ...august, ...filter }),
      ).rejects.toThrow("exactly one");
    }
  });
});
