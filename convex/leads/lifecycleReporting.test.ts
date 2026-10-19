import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { readLifecycle, syncLeadStageEntries } from "../lib/leadLifecycle";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const SEPTEMBER = { startDate: Date.parse("2026-09-01T00:00:00Z"), endDate: Date.parse("2026-10-01T00:00:00Z") };
const OCTOBER = { startDate: Date.parse("2026-10-01T00:00:00Z"), endDate: Date.parse("2026-11-01T00:00:00Z") };

// A person whose row was created on 16 October, with a September
// qualification on record.
async function lateRowPerson(harness: Harness) {
  await harness.t.run(async (ctx) => {
    const qualifiedAt = Date.parse("2026-09-20T10:00:00Z");
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(qualifiedAt),
      tenantId: harness.tenantId, fullName: "Late", status: "active", firstSeenAt: qualifiedAt, updatedAt: qualifiedAt,
    });
    await syncLeadStageEntries(ctx, harness.tenantId, leadId, null, readLifecycle((await ctx.db.get("leads", leadId))!));
  });
}

describe("leads report", () => {
  it("counts people in the month they reached Qualified, not the month their row was created", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const harness = await bookingHarness();
    await lateRowPerson(harness);

    const report = (range: typeof SEPTEMBER) =>
      harness.admin.query(api.reporting.leadConversion.getLeadConversionMetrics, range);
    expect(await report(OCTOBER)).toMatchObject({ newLeads: 0 });
    expect(await report(SEPTEMBER)).toMatchObject({ newLeads: 1 });
  });
});

describe("lead and customer list", () => {
  it("leaves a prospect out of the default list and shows them under the prospect filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const harness = await bookingHarness();
    const capturedAt = Date.parse("2026-10-10T10:00:00Z");
    const leadId = await harness.t.run(async (ctx) => {
      // The shape Phase 2 creates for a lead gen capture.
      const leadId = await ctx.db.insert("leads", {
        tenantId: harness.tenantId, fullName: "Prospect", status: "active", firstSeenAt: capturedAt,
        updatedAt: capturedAt, lifecycleStage: "prospect", lifecycleStageEnteredAt: { prospect: capturedAt },
        disposition: "open",
      });
      await rebuildLeadCustomerSearchRow(ctx, harness.tenantId, leadId);
      return leadId;
    });

    const list = (lifecycle?: "all" | "prospect" | "lead") =>
      harness.admin.query(api.leadCustomers.queries.listEntities, {
        paginationOpts: { numItems: 10, cursor: null },
        lifecycle,
      });
    expect((await list()).page).toHaveLength(0);
    expect((await list("lead")).page).toHaveLength(0);
    expect((await list("prospect")).page).toEqual([
      expect.objectContaining({ leadId, lifecycle: "prospect" }),
    ]);
  });
});
