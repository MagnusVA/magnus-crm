import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  MISSED_NOW,
  MISSED_RANGE,
  insertManyNoShows,
  seedMissedMeetings,
} from "../../tests/reportStageFixtures";
import { capMissedMeetingRows } from "../../lib/operations-reports/missed-meetings-export";
import { MISSED_MEETINGS_PAGE_SIZE } from "./missedMeetings";

// The No-shows and cancellations list (docs/plans/phase-5-deal-status.md
// §6.5): the deals a missed meeting closed, by when they closed, with the
// person's contact details and who worked the deal.

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type ListArgs = Omit<FunctionArgs<typeof api.operations.missedMeetings.listMissedMeetings>, "paginationOpts">;
type Row = FunctionReturnType<typeof api.operations.missedMeetings.listMissedMeetings>["page"][number];

async function seeded() {
  vi.useFakeTimers();
  vi.setSystemTime(MISSED_NOW);
  const harness = await bookingHarness();
  const seed = await harness.t.run((ctx) => seedMissedMeetings(ctx, harness.tenantId));
  return { harness, seed };
}

/** Every page, as the page loads them, sorted as it shows them: newest loss first. */
async function listAll(harness: Harness, args: Partial<ListArgs> = {}, numItems = 50) {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let calls = 0; calls < 100; calls += 1) {
    const result: FunctionReturnType<typeof api.operations.missedMeetings.listMissedMeetings> =
      await harness.admin.query(api.operations.missedMeetings.listMissedMeetings, {
        paginationOpts: { cursor, numItems },
        ...MISSED_RANGE,
        hideBookedAgain: true,
        ...args,
      });
    expect(result.page.length).toBeLessThanOrEqual(numItems);
    rows.push(...result.page);
    if (result.isDone) return capMissedMeetingRows(rows).rows;
    cursor = result.continueCursor;
  }
  throw new Error("The list never finished");
}

describe("the No-shows and cancellations list", () => {
  it("lists the deals a missed meeting closed in the range, newest first, without people who booked again", async () => {
    const { harness, seed } = await seeded();

    const rows = await listAll(harness);

    expect(rows.map((row) => row.opportunityId)).toEqual([seed.deals.noraDeal, seed.deals.calDeal]);
  });

  it("reads the deals by their latest activity, which the page sorts by when they closed", async () => {
    const { harness, seed } = await seeded();

    const page = await harness.admin.query(api.operations.missedMeetings.listMissedMeetings, {
      paginationOpts: { cursor: null, numItems: 50 },
      ...MISSED_RANGE,
      hideBookedAgain: true,
    });

    // Cal's note since the cancellation puts the deal first.
    expect(page.page.map((row) => row.opportunityId)).toEqual([seed.deals.calDeal, seed.deals.noraDeal]);
    expect(page.isDone).toBe(true);
  });

  it("gives each row the person's contact details, the missed meeting and who worked the deal", async () => {
    const { harness, seed } = await seeded();

    const [nora, cal] = await listAll(harness);

    expect(nora).toEqual({
      opportunityId: seed.deals.noraDeal,
      leadId: seed.leads.nora,
      personName: "Nora Noshow",
      instagramHandle: "nora.noshow",
      email: "nora@example.com",
      phone: "+15550001",
      missedMeeting: "no_show",
      lostAt: seed.lostAt.nora,
      meetingAt: seed.meetingAt.nora,
      source: "calendly",
      closerName: "closer@example.com",
      setterName: "Sam Setter",
      dmCloserName: "Dana DM",
      dmTeamName: "Team North",
      bookedAgain: false,
    });
    // The handle and phone come from identifier rows; the closer was deleted.
    expect(cal).toEqual({
      opportunityId: seed.deals.calDeal,
      leadId: seed.leads.cal,
      personName: "Cal Canceled",
      instagramHandle: "cal.canceled",
      email: "cal@example.com",
      phone: "+15550002",
      missedMeeting: "canceled",
      lostAt: seed.lostAt.cal,
      meetingAt: seed.meetingAt.cal,
      source: "slack_qualified",
      closerName: "Removed closer",
      setterName: null,
      dmCloserName: null,
      dmTeamName: null,
      bookedAgain: false,
    });
  });

  it("shows people who booked again, flagged, when asked", async () => {
    const { harness, seed } = await seeded();

    const rows = await listAll(harness, { hideBookedAgain: false });

    expect(rows.map((row) => [row.opportunityId, row.bookedAgain])).toEqual([
      [seed.deals.noraDeal, false],
      [seed.deals.calDeal, false],
      [seed.deals.ritaDeal, true],
    ]);
    expect(rows[2]).toMatchObject({ personName: "Rita Rebooked", meetingAt: seed.meetingAt.rita });
  });

  it("doesn't count a later deal with no booking, such as a new Slack qualification, as booking again", async () => {
    const { harness, seed } = await seeded();
    await harness.t.run(async (ctx) => {
      const nora = (await ctx.db.get("opportunities", seed.deals.noraDeal))!;
      await ctx.db.insert("opportunities", {
        tenantId: harness.tenantId,
        leadId: nora.leadId,
        stage: "qualified",
        outcome: "open",
        source: "slack_qualified",
        createdAt: MISSED_NOW - 1000,
        updatedAt: MISSED_NOW - 1000,
        latestActivityAt: MISSED_NOW - 1000,
      });
    });

    const rows = await listAll(harness, { hideBookedAgain: false });
    expect(rows.find((row) => row.opportunityId === seed.deals.noraDeal)?.bookedAgain).toBe(false);
  });

  it("picks no-shows or cancellations", async () => {
    const { harness, seed } = await seeded();

    expect((await listAll(harness, { kind: "no_show" })).map((row) => row.opportunityId)).toEqual([
      seed.deals.noraDeal,
    ]);
    expect(
      (await listAll(harness, { kind: "no_show", hideBookedAgain: false })).map((row) => row.opportunityId),
    ).toEqual([seed.deals.noraDeal, seed.deals.ritaDeal]);
    expect((await listAll(harness, { kind: "canceled" })).map((row) => row.opportunityId)).toEqual([
      seed.deals.calDeal,
    ]);
  });

  it("reads only the range asked for", async () => {
    const { harness, seed } = await seeded();

    const rows = await listAll(harness, {
      startDate: seed.lostAt.cal,
      endDate: seed.lostAt.nora,
    });

    expect(rows.map((row) => row.opportunityId)).toEqual([seed.deals.calDeal]);
  });

  it("pages through the same rows a deal at a time", async () => {
    const { harness } = await seeded();

    const onePerPage = await listAll(harness, { hideBookedAgain: false }, 1);
    expect(onePerPage).toHaveLength(3);

    expect(onePerPage).toEqual(await listAll(harness, { hideBookedAgain: false }));
  });

  it("reads at most a page of deals a call, whatever it is asked for", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MISSED_NOW);
    const harness = await bookingHarness();
    await harness.t.run((ctx) => insertManyNoShows(ctx, harness.tenantId, MISSED_MEETINGS_PAGE_SIZE + 1));

    const first = await harness.admin.query(api.operations.missedMeetings.listMissedMeetings, {
      paginationOpts: { cursor: null, numItems: 10_000 },
      ...MISSED_RANGE,
      hideBookedAgain: true,
    });

    expect(first.page).toHaveLength(MISSED_MEETINGS_PAGE_SIZE);
    expect(first.isDone).toBe(false);
    const rest = await harness.admin.query(api.operations.missedMeetings.listMissedMeetings, {
      paginationOpts: { cursor: first.continueCursor, numItems: 10_000 },
      ...MISSED_RANGE,
      hideBookedAgain: true,
    });
    expect(rest.page).toHaveLength(1);
    expect(rest.isDone).toBe(true);
  });

  it("is for admins only", async () => {
    const { harness } = await seeded();
    const args = {
      paginationOpts: { cursor: null, numItems: 50 },
      ...MISSED_RANGE,
      hideBookedAgain: true,
    };

    await expect(harness.closer.query(api.operations.missedMeetings.listMissedMeetings, args)).rejects.toThrow();
    await expect(harness.t.query(api.operations.missedMeetings.listMissedMeetings, args)).rejects.toThrow();
  });

  it("rejects a range that ends before it starts", async () => {
    const { harness } = await seeded();

    await expect(
      harness.admin.query(api.operations.missedMeetings.listMissedMeetings, {
        paginationOpts: { cursor: null, numItems: 50 },
        startDate: MISSED_RANGE.endDate,
        endDate: MISSED_RANGE.startDate,
        hideBookedAgain: true,
      }),
    ).rejects.toThrow("startDate must be earlier than endDate");
  });
});
