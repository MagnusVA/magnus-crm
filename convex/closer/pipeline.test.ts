import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  DAY,
  PERIOD,
  T0,
  seededCloserPipeline,
} from "../../tests/closerPipelineFixtures";

// The closer's pipeline list reads the deal's position, on
// by_tenantId_assignedCloserId_stage_outcome_createdAt
// (docs/plans/phase-5-deal-status.md §6.2).

const firstPage = { numItems: 50, cursor: null };

type Harness = Awaited<ReturnType<typeof seededCloserPipeline>>["harness"];
type ListArgs = Omit<FunctionArgs<typeof api.closer.pipeline.listMyOpportunities>, "paginationOpts">;

async function list(harness: Harness, args: ListArgs = {}) {
  return await harness.closer.query(api.closer.pipeline.listMyOpportunities, {
    paginationOpts: firstPage,
    ...args,
  });
}

const ids = (page: Array<{ _id: Id<"opportunities"> }>) => page.map((row) => row._id);

describe("listMyOpportunities", () => {
  it("lists the closer's deals at one position, the last updated first", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;

    expect(ids((await list(harness, { positionFilter: "booked" })).page)).toEqual([deals.booked]);
    expect(ids((await list(harness, { positionFilter: "call_held" })).page)).toEqual([deals.sideDeal]);
    expect(ids((await list(harness, { positionFilter: "follow_up" })).page)).toEqual([
      deals.reminder,
      deals.linkSent,
      deals.bareFollowUp,
    ]);
    expect(ids((await list(harness, { positionFilter: "won" })).page)).toEqual([deals.won]);
    // The missed meetings' deals are Lost, beside the person's loss; the
    // other closer's isn't the closer's.
    expect(ids((await list(harness, { positionFilter: "lost" })).page)).toEqual([
      deals.noShow,
      deals.lostByCloser,
      deals.canceled,
    ]);
    expect((await list(harness, { positionFilter: "qualified" })).page).toEqual([]);
    expect((await list(harness)).page).toHaveLength(9);
  });

  it("keeps to the deals created in the period, with or without a position", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;

    expect(ids((await list(harness, { ...PERIOD, positionFilter: "lost" })).page)).toEqual([
      deals.noShow,
      deals.lostByCloser,
    ]);
    expect(ids((await list(harness, { ...PERIOD, positionFilter: "follow_up" })).page)).toEqual([
      deals.reminder,
      deals.linkSent,
    ]);
    expect(ids((await list(harness, PERIOD)).page)).toEqual([
      deals.noShow,
      deals.lostByCloser,
      deals.won,
      deals.reminder,
      deals.linkSent,
      deals.sideDeal,
      deals.booked,
    ]);
    // The period's end is exclusive.
    expect(
      (await list(harness, { periodStart: T0 - DAY, periodEnd: T0, positionFilter: "lost" })).page,
    ).toEqual([]);
  });

  it("shows each row's position, the missed meeting that closed it, and no status", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    const rows = new Map((await list(harness)).page.map((row) => [row._id, row]));

    expect(rows.get(deals.booked)).toMatchObject({ position: "booked", missedMeeting: null });
    expect(rows.get(deals.sideDeal)).toMatchObject({ position: "call_held", missedMeeting: null });
    expect(rows.get(deals.won)).toMatchObject({ position: "won", missedMeeting: null });
    expect(rows.get(deals.lostByCloser)).toMatchObject({ position: "lost", missedMeeting: null });
    expect(rows.get(deals.noShow)).toMatchObject({ position: "lost", missedMeeting: "no_show" });
    expect(rows.get(deals.canceled)).toMatchObject({ position: "lost", missedMeeting: "canceled" });
    for (const row of rows.values()) {
      expect(row).not.toHaveProperty("status");
      expect(row).toMatchObject({ leadName: "deal-person@example.com" });
    }
  });

  it("gives each Follow-up row its next step: the reschedule link, else the earliest pending reminder", async () => {
    const { harness, seed } = await seededCloserPipeline();
    const { deals } = seed;
    const rows = new Map((await list(harness)).page.map((row) => [row._id, row]));

    // The reschedule link outranks the reminder beside it.
    expect(rows.get(deals.linkSent)?.nextStep).toEqual({ kind: "reschedule_link_sent" });
    // The earliest pending reminder; the done one and the ordinary
    // scheduling link don't count.
    expect(rows.get(deals.reminder)?.nextStep).toEqual({
      kind: "reminder",
      reminderScheduledAt: T0 + 3 * DAY,
    });
    expect(rows.get(deals.bareFollowUp)?.nextStep).toBeNull();
    for (const id of [deals.booked, deals.sideDeal, deals.won, deals.noShow]) {
      expect(rows.get(id)?.nextStep).toBeNull();
    }
  });

  it("pages through the closer's deals", async () => {
    const { harness } = await seededCloserPipeline();
    const seen: Array<Id<"opportunities">> = [];
    let cursor: string | null = null;
    for (let call = 0; call < 10; call += 1) {
      const result: FunctionReturnType<typeof api.closer.pipeline.listMyOpportunities> =
        await harness.closer.query(api.closer.pipeline.listMyOpportunities, {
          paginationOpts: { numItems: 4, cursor },
        });
      seen.push(...ids(result.page));
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(new Set(seen).size).toBe(9);
    expect(seen).toHaveLength(9);
  });

  it("refuses an admin", async () => {
    const { harness } = await seededCloserPipeline();
    await expect(
      harness.admin.query(api.closer.pipeline.listMyOpportunities, { paginationOpts: firstPage }),
    ).rejects.toThrow();
  });
});
