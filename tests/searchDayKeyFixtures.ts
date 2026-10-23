import migrationsTest from "@convex-dev/migrations/test";
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { migrations } from "../convex/migrations";
import { bookingHarness } from "./bookingHarness";
import { insertDeal, insertPerson } from "./enrollmentReadFixtures";
import { upsertOpportunitySearchProjection } from "../convex/lib/opportunitySearch";

export async function searchDayKeyHarness() {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const opportunityId = await harness.t.run(async (ctx) => {
    const leadId = await insertPerson(ctx, harness.tenantId, { fullName: "Search fixture" });
    const opportunityId = await insertDeal(ctx, { tenantId: harness.tenantId, leadId });
    await upsertOpportunitySearchProjection(ctx, opportunityId);
    return opportunityId;
  });
  async function row() {
    return await harness.t.run((ctx) => ctx.db.query("opportunitySearch")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId)).unique());
  }
  async function run(name: string) {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset: true });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [status] = await harness.t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
    );
    return status;
  }
  return { ...harness, opportunityId, row, run };
}
