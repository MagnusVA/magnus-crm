import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import {
  BOOKED_CALLS_ADMIN,
  BOOKED_CALLS_WINDOW,
  seedBookedCallsFixture,
} from "../../tests/bookedCallsFixture";
import { moveDealTo } from "../../tests/reportStageFixtures";

// The Booked Calls and Sales Calls details show the deal's stage from the
// deal they load, not the meeting's copy of its status
// (docs/plans/phase-5-deal-status.md §6.6).

// The fixture's calls are a day after their bookings.
const CALLS_WINDOW = {
  start: BOOKED_CALLS_WINDOW.start + 86_400_000,
  end: BOOKED_CALLS_WINDOW.end + 86_400_000,
};

async function setup() {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => await seedBookedCallsFixture(ctx));
  // Deal G closes on its no-show; deal B is won. Their meetings keep the
  // status they copied when booked.
  const deals = await t.run(async (ctx) => {
    const dealOf = async (meetingId: Id<"meetings">) =>
      (await ctx.db.get("meetings", meetingId))!.opportunityId;
    const noShow = await dealOf(fixture.meetings.legacyNorthB);
    const won = await dealOf(fixture.meetings.firstNorthA2);
    await moveDealTo(ctx, noShow, "no_show");
    await moveDealTo(ctx, won, "payment_received");
    for (const meetingId of [fixture.meetings.legacyNorthB, fixture.meetings.firstNorthA2]) {
      await ctx.db.patch("meetings", meetingId, { opportunityStatus: "scheduled" });
    }
    return { noShow, won };
  });
  return { t, fixture, deals, admin: t.withIdentity(BOOKED_CALLS_ADMIN) };
}

type Admin = Awaited<ReturnType<typeof setup>>["admin"];
type DealStageFields = { meetingId: Id<"meetings">; dealPosition: string | null; dealSystemLoss: string | null };

const stages = (rows: DealStageFields[]) =>
  Object.fromEntries(rows.map((row) => [row.meetingId, [row.dealPosition, row.dealSystemLoss]]));

async function bookedCalls(admin: Admin) {
  const rows: FunctionReturnType<typeof api.operations.bookedCallsDashboard.listBookedCallsDetails>["page"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const result: FunctionReturnType<typeof api.operations.bookedCallsDashboard.listBookedCallsDetails> =
      await admin.query(api.operations.bookedCallsDashboard.listBookedCallsDetails, {
        paginationOpts: { cursor, numItems: 2 },
        ...BOOKED_CALLS_WINDOW,
      });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("listBookedCallsDetails never finished.");
}

async function salesCalls(admin: Admin) {
  const rows: FunctionReturnType<typeof api.operations.phoneSales.listPhoneSalesMeetings>["page"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const result: FunctionReturnType<typeof api.operations.phoneSales.listPhoneSalesMeetings> =
      await admin.query(api.operations.phoneSales.listPhoneSalesMeetings, {
        paginationOpts: { cursor, numItems: 25 },
        scheduledFrom: CALLS_WINDOW.start,
        scheduledTo: CALLS_WINDOW.end,
      });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("listPhoneSalesMeetings never finished.");
}

describe("the call details' deal stage", () => {
  it("shows each booked call's deal position, and the loss the system wrote on it", async () => {
    const { fixture, admin } = await setup();

    expect(stages(await bookedCalls(admin))).toEqual({
      [fixture.meetings.firstNorthA]: ["booked", null],
      [fixture.meetings.firstNorthA2]: ["won", null],
      [fixture.meetings.legacyNorthB]: ["lost", "no_show"],
    });
    const search = await admin.query(api.operations.bookedCallsDashboard.searchBookedCallsDetails, {
      searchTerm: "golf",
      ...BOOKED_CALLS_WINDOW,
    });
    expect(stages(search)).toEqual({ [fixture.meetings.legacyNorthB]: ["lost", "no_show"] });
  });

  it("shows each sales call's deal position, in the list and in search", async () => {
    const { fixture, admin } = await setup();

    const rows = stages(await salesCalls(admin));
    expect(rows[fixture.meetings.legacyNorthB]).toEqual(["lost", "no_show"]);
    expect(rows[fixture.meetings.firstNorthA2]).toEqual(["won", null]);
    expect(rows[fixture.meetings.firstNorthA]).toEqual(["booked", null]);
    expect(rows[fixture.meetings.rebookNorthB]).toEqual(["booked", null]);

    const search = await admin.query(api.operations.salesCallsDashboard.searchSalesCallsMeetings, {
      searchTerm: "golf",
      ...CALLS_WINDOW,
    });
    expect(stages(search)).toEqual({ [fixture.meetings.legacyNorthB]: ["lost", "no_show"] });
  });

  it("no longer takes a status filter on the sales calls list", async () => {
    const { admin } = await setup();
    await expect(
      admin.query(api.operations.phoneSales.listPhoneSalesMeetings, {
        paginationOpts: { cursor: null, numItems: 25 },
        scheduledFrom: CALLS_WINDOW.start,
        scheduledTo: CALLS_WINDOW.end,
        opportunityStatus: "scheduled",
      } as never),
    ).rejects.toThrow("Unexpected field `opportunityStatus`");
  });
});
