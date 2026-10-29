import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DAY, T0, seededCloserPipeline } from "../../tests/closerPipelineFixtures";
import {
  insertCloserPayment,
  insertProgram,
  namePersonForSearch,
} from "../../tests/closerPipelineDeskFixtures";

// My Pipeline's lookup, "All deals": the closer's deals by outcome tab,
// program and person, the last active first.

type Harness = Awaited<ReturnType<typeof seededCloserPipeline>>["harness"];
type ListArgs = FunctionArgs<typeof api.closer.pipeline.listMyOpportunities>;

async function list(harness: Harness, args: Partial<ListArgs> = {}) {
  return await harness.closer.query(api.closer.pipeline.listMyOpportunities, {
    tab: "all",
    limit: 50,
    ...args,
  });
}

const ids = (rows: Array<{ opportunityId: Id<"opportunities"> }>) =>
  rows.map((row) => row.opportunityId);

describe("listMyOpportunities", () => {
  it("lists the closer's deals by outcome tab, the last active first, with each tab's count", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;

    const all = await list(harness);
    expect(all.counts).toEqual({ all: 9, open: 5, won: 1, lost: 3 });
    expect(ids(all.rows)).toEqual([
      deals.noShow,
      deals.lostByCloser,
      deals.won,
      deals.reminder,
      deals.linkSent,
      deals.sideDeal,
      deals.booked,
      deals.bareFollowUp,
      deals.canceled,
    ]);
    expect(ids((await list(harness, { tab: "open" })).rows)).toEqual([
      deals.reminder,
      deals.linkSent,
      deals.sideDeal,
      deals.booked,
      deals.bareFollowUp,
    ]);
    expect(ids((await list(harness, { tab: "won" })).rows)).toEqual([deals.won]);
    // The missed meetings' losses are Lost, beside the person's loss; the
    // other closer's isn't the closer's.
    expect(ids((await list(harness, { tab: "lost" })).rows)).toEqual([
      deals.noShow,
      deals.lostByCloser,
      deals.canceled,
    ]);
  });

  it("sorts by the deal's last activity when it has one", async () => {
    const { harness, seed } = await seededCloserPipeline();
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", seed.deals.canceled, { latestActivityAt: T0 + 10 * DAY });
    });
    const rows = (await list(harness)).rows;
    expect(rows[0]).toMatchObject({ opportunityId: seed.deals.canceled, lastActivityAt: T0 + 10 * DAY });
  });

  it("returns the first `limit` rows and how many the tab matched", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const page = await list(harness, { limit: 2 });
    expect(ids(page.rows)).toEqual([seed.deals.noShow, seed.deals.lostByCloser]);
    expect(page).toMatchObject({ matched: 9, isPartial: false });
  });

  it("filters by program, sold before first booked, and lists the programs the closer has deals in", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    const programs = await harness.t.run(async (ctx) => {
      const accelerator = await insertProgram(ctx, harness.tenantId, harness.closerId, "Accelerator");
      const elite = await insertProgram(ctx, harness.tenantId, harness.closerId, "Elite Mentorship");
      await ctx.db.patch("opportunities", deals.won, { soldProgramId: accelerator });
      await ctx.db.patch("opportunities", deals.booked, { firstBookingProgramId: accelerator });
      await ctx.db.patch("opportunities", deals.sideDeal, {
        firstBookingProgramId: accelerator,
        soldProgramId: elite,
      });
      return { accelerator, elite };
    });

    const accelerator = await list(harness, { programKey: programs.accelerator });
    expect(ids(accelerator.rows)).toEqual([deals.won, deals.booked]);
    expect(accelerator.counts).toEqual({ all: 2, open: 1, won: 1, lost: 0 });
    expect(accelerator.rows[0]).toMatchObject({ programName: "Accelerator" });
    expect(ids((await list(harness, { programKey: programs.elite })).rows)).toEqual([deals.sideDeal]);
    expect((await list(harness, { programKey: "none" })).counts.all).toBe(6);
    expect(new Set(accelerator.programs)).toEqual(
      new Set([
        { programKey: programs.accelerator, programName: "Accelerator", deals: 2 },
        { programKey: programs.elite, programName: "Elite Mentorship", deals: 1 },
        { programKey: "none", programName: null, deals: 6 },
      ]),
    );
  });

  it("finds the closer's deals by the person's name", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    await harness.t.run(async (ctx) => {
      await namePersonForSearch(ctx, deals.won, "Ana Lucia Paz");
      await namePersonForSearch(ctx, deals.booked, "Marco Ayala");
      await namePersonForSearch(ctx, deals.otherClosers, "Ana Ferrer");
    });

    const found = await list(harness, { search: "Ana" });
    // The other closer's Ana isn't the closer's.
    expect(ids(found.rows)).toEqual([deals.won]);
    expect(found.rows[0]).toMatchObject({ personName: "Ana Lucia Paz" });
    expect(found.counts).toEqual({ all: 1, open: 0, won: 1, lost: 0 });
    expect((await list(harness, { search: "Nobody" })).rows).toEqual([]);
    // A blank search is no search.
    expect((await list(harness, { search: "  " })).counts.all).toBe(9);
  });

  it("gives open rows their next call and task, and closed rows none", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", deals.booked, { nextMeetingAt: T0 + 2 * DAY });
    });
    const rows = new Map((await list(harness)).rows.map((row) => [row.opportunityId, row]));

    expect(rows.get(deals.booked)?.nextStep).toEqual({ callAt: T0 + 2 * DAY, task: null });
    expect(rows.get(deals.reminder)?.nextStep).toEqual({
      callAt: null,
      task: { kind: "task", method: "call", dueAt: T0 + 3 * DAY },
    });
    expect(rows.get(deals.bareFollowUp)?.nextStep).toEqual({ callAt: null, task: null });
    for (const id of [deals.won, deals.noShow, deals.lostByCloser]) {
      expect(rows.get(id)?.nextStep).toBeNull();
    }
    expect(rows.get(deals.noShow)).toMatchObject({ position: "lost", systemLoss: "no_show" });
    expect(rows.get(deals.lostByCloser)).toMatchObject({ position: "lost", systemLoss: null });
  });

  it("says what was paid on each deal by currency, disputed payments left out", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    await harness.t.run(async (ctx) => {
      const programId = await insertProgram(ctx, harness.tenantId, harness.closerId, "Accelerator");
      const pay = (amountMinor: number, extra = {}) =>
        insertCloserPayment(ctx, {
          tenantId: harness.tenantId,
          closerId: harness.closerId,
          programId,
          amountMinor,
          opportunityId: deals.won,
          ...extra,
        });
      await pay(300_000);
      await pay(200_000);
      await pay(100_000, { currency: "EUR" });
      await pay(900_000, { status: "disputed" });
    });
    const rows = new Map((await list(harness)).rows.map((row) => [row.opportunityId, row]));

    expect(rows.get(deals.won)?.paid).toEqual([
      { currency: "USD", amountMinor: 500_000 },
      { currency: "EUR", amountMinor: 100_000 },
    ]);
    expect(rows.get(deals.lostByCloser)?.paid).toEqual([]);
  });

  it("refuses an admin", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(
      harness.admin.query(api.closer.pipeline.listMyOpportunities, { tab: "all", limit: 25 }),
    ).rejects.toThrow();
  });
});
