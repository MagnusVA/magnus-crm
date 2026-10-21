/**
 * `rebuildCustomerSearchRows` re-projects each customer's row from enrollments
 * without the customer, and `assertLeadCustomerSearchRowsBackfilled` checks
 * every row against that projection (docs/plans/phase-4-customers.md §8,
 * §10.4).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { migrations } from "../migrations";
import { bookingHarness } from "../../tests/bookingHarness";
import { T0, fixtureUsers, insertPerson, insertProgram, seedCustomer } from "../../tests/enrollmentReadFixtures";

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

/** A customer and a lead whose rows the customer projection wrote. */
async function seedLegacyRows(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    const program = await insertProgram(ctx, tenantId, admin._id, "Program");
    const customer = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: T0 });
    const leadId = await insertPerson(ctx, tenantId, { fullName: "Still a lead" });
    const legacyRow = (
      leadIdForRow: Id<"leads">,
      fields: { customerId?: Id<"customers">; lifecycle: "customer" | "lead"; leadStatus: "active" | "converted" },
    ) =>
      ctx.db.insert("leadCustomerSearchRows", {
        tenantId,
        leadId: leadIdForRow,
        ...fields,
        isSearchVisible: true,
        customerStatus: fields.customerId ? "active" : undefined,
        displayName: "Row",
        searchText: "row",
        opportunityCount: 1,
        wonOpportunityCount: fields.customerId ? 1 : 0,
        meetingCount: 1,
        latestActivityAt: T0,
        firstSeenAt: T0,
        convertedAt: fields.customerId ? T0 : undefined,
        totalPaidMinor: fields.customerId ? 100_000 : undefined,
        paymentCurrency: fields.customerId ? "USD" : undefined,
        updatedAt: T0,
      });
    await legacyRow(customer.leadId, {
      customerId: customer.customerId,
      lifecycle: "customer",
      leadStatus: "converted",
    });
    await legacyRow(leadId, { lifecycle: "lead", leadStatus: "active" });
    return { customer, leadId };
  });
}

describe("customer search row migrations", () => {
  it("fail the assert while a row names a customer, and pass once rebuilt", async () => {
    const harness = await harnessWithMigrations();
    const { customer } = await seedLegacyRows(harness);

    expect((await run(harness, "assertLeadCustomerSearchRowsBackfilled"))?.error).toContain(
      "still names a customer",
    );
    expect((await run(harness, "rebuildCustomerSearchRows"))?.isDone).toBe(true);
    expect((await run(harness, "assertLeadCustomerSearchRowsBackfilled", true))?.error).toBeUndefined();

    const row = await harness.t.run((ctx) =>
      ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", harness.tenantId).eq("leadId", customer.leadId),
        )
        .unique(),
    );
    expect(row?.customerId).toBeUndefined();
    expect(row).toMatchObject({ lifecycle: "customer", customerStatus: "active", totalPaidMinor: 100_000 });
  });

  it("fail the assert on a row whose status differs from the enrollments", async () => {
    const harness = await harnessWithMigrations();
    const { customer } = await seedLegacyRows(harness);
    expect((await run(harness, "rebuildCustomerSearchRows"))?.isDone).toBe(true);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("enrollments", customer.enrollmentId, { status: "churned" });
    });

    expect((await run(harness, "assertLeadCustomerSearchRowsBackfilled"))?.error).toContain(
      "stale customerStatus projection",
    );
  });
});
