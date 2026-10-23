import { vi } from "vitest";
import { bookingHarness } from "./bookingHarness";
import { insertDeal, type DealFields } from "./dealStageFixtures";
import type { OpportunityStatus } from "../convex/opportunities/stages";

export const NOW = Date.UTC(2026, 9, 22, 12);
export const DAY = 86400000;
export const MONTH = { startDate: Date.UTC(2026, 9, 1), endDate: Date.UTC(2026, 10, 1) };
export const ALL_MONTHS = { startDate: Date.UTC(2026, 3, 1), endDate: MONTH.endDate };

export async function pipelineHealthFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const actorId = await harness.t.run(async (ctx) => (await ctx.db.query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique())!._id);
  const deal = (status: OpportunityStatus = "scheduled", fields: DealFields = {}) =>
    harness.t.run((ctx) => insertDeal(ctx, {
      tenantId: harness.tenantId,
      status,
      fields: { createdAt: NOW - 30 * DAY, latestActivityAt: NOW, assignedCloserId: actorId, ...fields },
    }));
  return { ...harness, actorId, deal };
}
