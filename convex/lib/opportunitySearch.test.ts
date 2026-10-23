import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDayKeyHarness } from "../../tests/searchDayKeyFixtures";
import { upsertOpportunitySearchProjection } from "./opportunitySearch";

afterEach(() => vi.useRealTimers());

const keys = ["activityDayKey", "activityWeekKey", "activityMonthKey"] as const;

describe("opportunity search day key retirement", () => {
  it("creates and rebuilds searchable projections without day keys", async () => {
    const h = await searchDayKeyHarness();
    const before = (await h.row())!;
    expect(before.searchText).toContain("Search fixture");
    for (const key of keys) expect(before).not.toHaveProperty(key);
    await h.t.run((ctx) => upsertOpportunitySearchProjection(ctx, h.opportunityId));
    const after = (await h.row())!;
    for (const key of keys) expect(after).not.toHaveProperty(key);
    expect(after).toEqual(before);
    const status = await h.run("assertOpportunitySearchProjectionBackfilled");
    expect(status?.isDone).toBe(true);
    expect(status?.error).toBeUndefined();
  });
});
