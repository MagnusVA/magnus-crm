import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { OpportunityStatus } from "../lib/statusTransitions";
import type { DealPosition, DealSource } from "../opportunities/stages";
import { bookingHarness } from "../../tests/bookingHarness";
import { insertQualification, insertWrittenDeal } from "../../tests/dealStateFixtures";

// The Qualifications filter takes the six positions through the row's
// dealStage and dealOutcome (docs/plans/phase-5-deal-status.md §6.6, §7): the
// index for the list, the search filter for search.

afterEach(() => vi.useRealTimers());

const QUALIFIED_AT = Date.parse("2026-09-01T12:00:00Z");
const WINDOW = {
  qualifiedAfter: Date.parse("2026-09-01T00:00:00Z"),
  qualifiedBefore: Date.parse("2026-10-01T00:00:00Z"),
};

// A qualification on a deal at every status, and one that linked no deal.
const DEALS: Array<[OpportunityStatus, DealSource]> = [
  ["qualified_pending", "slack_qualified"],
  ["scheduled", "slack_qualified"],
  ["scheduled", "side_deal"],
  ["follow_up_scheduled", "slack_qualified"],
  ["reschedule_link_sent", "slack_qualified"],
  ["payment_received", "slack_qualified"],
  ["lost", "slack_qualified"],
  ["canceled", "slack_qualified"],
  ["no_show", "slack_qualified"],
];

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function seed(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const events: Record<string, Id<"slackQualificationEvents">> = {};
    for (const [index, [status, source]] of DEALS.entries()) {
      const opportunityId = await insertWrittenDeal(ctx, { tenantId: harness.tenantId, status, source });
      events[`${status}/${source}`] = await insertQualification(ctx, {
        tenantId: harness.tenantId,
        qualifiedAt: QUALIFIED_AT + index * 60_000,
        opportunityId,
      });
    }
    events.unlinked = await insertQualification(ctx, {
      tenantId: harness.tenantId,
      qualifiedAt: QUALIFIED_AT + DEALS.length * 60_000,
    });
    return events;
  });
}

type QueueRow = { qualificationEventId: Id<"slackQualificationEvents">; dealPosition: DealPosition | null };

async function listAll(harness: Harness, positionFilter?: DealPosition) {
  const rows: QueueRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const result: { page: QueueRow[]; isDone: boolean; continueCursor: string } =
      await harness.admin.query(api.operations.qualifications.listQualificationQueue, {
        paginationOpts: { cursor, numItems: 25 },
        ...WINDOW,
        ...(positionFilter ? { positionFilter } : {}),
      });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("Queue did not finish paging");
}

const ids = (rows: QueueRow[]) => rows.map((row) => row.qualificationEventId).sort();

describe("the Qualifications filter by position", () => {
  it("lists each position's rows, Lost holding the canceled and no-show deals", async () => {
    const harness = await bookingHarness();
    const events = await seed(harness);

    const expected: Record<DealPosition, string[]> = {
      qualified: ["qualified_pending/slack_qualified"],
      booked: ["scheduled/slack_qualified"],
      call_held: ["scheduled/side_deal"],
      follow_up: ["follow_up_scheduled/slack_qualified", "reschedule_link_sent/slack_qualified"],
      won: ["payment_received/slack_qualified"],
      lost: ["lost/slack_qualified", "canceled/slack_qualified", "no_show/slack_qualified"],
    };
    for (const [position, keys] of Object.entries(expected) as [DealPosition, string[]][]) {
      const rows = await listAll(harness, position);
      expect(ids(rows), position).toEqual(keys.map((key) => events[key]).sort());
      expect(rows.every((row) => row.dealPosition === position)).toBe(true);
    }
  });

  it("lists every row with its position, and none for a qualification with no deal", async () => {
    const harness = await bookingHarness();
    const events = await seed(harness);

    const rows = await listAll(harness);

    expect(rows).toHaveLength(DEALS.length + 1);
    const positions = Object.fromEntries(rows.map((row) => [row.qualificationEventId, row.dealPosition]));
    expect(positions[events.unlinked]).toBeNull();
    expect(positions[events["scheduled/side_deal"]]).toBe("call_held");
    expect(positions[events["no_show/slack_qualified"]]).toBe("lost");
  });

  it("searches within a position through the search filter", async () => {
    const harness = await bookingHarness();
    const events = await seed(harness);

    const lost = await harness.admin.query(api.operations.qualifications.searchQualificationQueue, {
      searchTerm: "qualified person",
      positionFilter: "lost",
      ...WINDOW,
    });
    expect(ids(lost)).toEqual(
      [events["lost/slack_qualified"], events["canceled/slack_qualified"], events["no_show/slack_qualified"]].sort(),
    );
    const callHeld = await harness.admin.query(api.operations.qualifications.searchQualificationQueue, {
      searchTerm: "qualified person",
      positionFilter: "call_held",
      ...WINDOW,
    });
    expect(callHeld.map((row) => [row.qualificationEventId, row.dealPosition])).toEqual([
      [events["scheduled/side_deal"], "call_held"],
    ]);
  });

  it("takes one primary filter at a time", async () => {
    const harness = await bookingHarness();
    await expect(
      harness.admin.query(api.operations.qualifications.listQualificationQueue, {
        paginationOpts: { cursor: null, numItems: 25 },
        ...WINDOW,
        positionFilter: "won",
        slackUserId: "U1",
      }),
    ).rejects.toThrow("Select only one primary qualification filter at a time.");
  });
});
