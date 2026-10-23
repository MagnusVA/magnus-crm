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

  it("clears all keys directly, preserves other fields, and is idempotent", async () => {
    const h = await searchDayKeyHarness();
    const before = (await h.row())!;
    await h.t.run((ctx) => ctx.db.patch("opportunitySearch", before._id, {
      activityDayKey: "2026-10-22", activityWeekKey: "2026-10-18", activityMonthKey: "2026-10",
    }));
    const status = await h.run("clearOpportunitySearchDayKeys");
    expect(status?.isDone).toBe(true);
    expect(status?.error).toBeUndefined();
    expect(await h.row()).toEqual(before);
    expect((await h.run("assertOpportunitySearchDayKeysCleared"))?.error).toBeUndefined();
    expect((await h.run("clearOpportunitySearchDayKeys"))?.error).toBeUndefined();
    expect(await h.row()).toEqual(before);
  });

  it.each(keys)("rejects and clears a row with only %s set, including an empty string", async (key) => {
    const h = await searchDayKeyHarness();
    const before = (await h.row())!;
    await h.t.run((ctx) => ctx.db.patch("opportunitySearch", before._id, { [key]: "" }));
    expect((await h.run("assertOpportunitySearchDayKeysCleared"))?.error).toContain(before._id);
    expect((await h.run("clearOpportunitySearchDayKeys"))?.error).toBeUndefined();
    expect(await h.row()).toEqual(before);
    const status = await h.run("assertOpportunitySearchDayKeysCleared");
    expect(status?.isDone).toBe(true);
    expect(status?.error).toBeUndefined();
  });
});
