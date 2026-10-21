/**
 * `assertLeadCustomerSearchRowsBackfilled` checks every row against the
 * projection from enrollments (docs/plans/phase-4-customers.md §8).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { migrations } from "../migrations";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  T0,
  fixtureUsers,
  insertPerson,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function harnessWithMigrations() {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  return harness;
}

async function run(harness: Harness, name: string, reset = false) {
  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await harness.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

/** A customer and a lead, with the rows the backfill projects for them. */
async function seedProjectedRows(harness: Harness) {
  const seeded = await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    const program = await insertProgram(ctx, tenantId, admin._id, "Program");
    const customer = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: T0 });
    const leadId = await insertPerson(ctx, tenantId, { fullName: "Still a lead" });
    return { customer, leadId };
  });
  expect((await run(harness, "backfillLeadCustomerSearchRows"))?.isDone).toBe(true);
  return seeded;
}

async function searchRow(harness: Harness, leadId: Id<"leads">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", harness.tenantId).eq("leadId", leadId))
      .unique(),
  );
}

describe("assertLeadCustomerSearchRowsBackfilled", () => {
  it("passes on rows projected from enrollments", async () => {
    const harness = await harnessWithMigrations();
    const { customer, leadId } = await seedProjectedRows(harness);

    expect((await run(harness, "assertLeadCustomerSearchRowsBackfilled"))?.error).toBeUndefined();
    expect(await searchRow(harness, customer.leadId)).toMatchObject({
      lifecycle: "customer",
      customerStatus: "active",
      totalPaidMinor: 100_000,
      convertedAt: T0,
    });
    const leadRow = await searchRow(harness, leadId);
    expect(leadRow?.lifecycle).toBe("lead");
    expect(leadRow?.customerStatus).toBeUndefined();
  });

  it("names a row whose status differs from the enrollments", async () => {
    const harness = await harnessWithMigrations();
    const { customer } = await seedProjectedRows(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("enrollments", customer.enrollmentId, { status: "churned" });
    });

    const error = (await run(harness, "assertLeadCustomerSearchRowsBackfilled"))?.error;
    expect(error).toContain(customer.leadId);
    expect(error).toContain("stale customerStatus projection");
  });

  it("names a lead with no row", async () => {
    const harness = await harnessWithMigrations();
    const { leadId } = await seedProjectedRows(harness);
    const row = await searchRow(harness, leadId);
    await harness.t.run((ctx) => ctx.db.delete("leadCustomerSearchRows", row!._id));

    const error = (await run(harness, "assertLeadCustomerSearchRowsBackfilled"))?.error;
    expect(error).toContain(leadId);
    expect(error).toContain("missing leadCustomerSearchRows row");
  });
});
