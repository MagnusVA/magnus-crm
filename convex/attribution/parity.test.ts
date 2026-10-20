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

