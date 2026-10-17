import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { correctLeadLifecycle, countLeadStageEntries } from "../lib/leadLifecycle";
import { insertLeadAggregate } from "../reporting/writeHooks";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const SEPTEMBER = { startDate: Date.parse("2026-09-01T00:00:00Z"), endDate: Date.parse("2026-10-01T00:00:00Z") };
const OCTOBER = { startDate: Date.parse("2026-10-01T00:00:00Z"), endDate: Date.parse("2026-11-01T00:00:00Z") };

async function run(harness: Harness, name: string) {
  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

// A person the split created on 16 October, whose real qualification was in
// September: today's report counts them in October.
async function splitCreatedPerson(harness: Harness) {
  await harness.t.run(async (ctx) => {
    const qualifiedAt = Date.parse("2026-09-20T10:00:00Z");
    const leadId = await ctx.db.insert("leads", {
      tenantId: harness.tenantId, fullName: "Split", status: "active", firstSeenAt: qualifiedAt, updatedAt: qualifiedAt,
    });
    await insertLeadAggregate(ctx, leadId);
    await ctx.db.insert("opportunities", {
      tenantId: harness.tenantId, leadId, status: "qualified_pending", source: "slack_qualified",
      qualifiedAt, qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: qualifiedAt },
      createdAt: qualifiedAt, updatedAt: qualifiedAt,
    });
  });
}

describe("leads report", () => {
  it("counts people reaching Qualified once the verified backfill is activated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const harness = await bookingHarness();
    migrationsTest.register(harness.t);
    await splitCreatedPerson(harness);

    const report = (range: typeof SEPTEMBER) =>
      harness.admin.query(api.reporting.leadConversion.getLeadConversionMetrics, range);
    expect(await report(OCTOBER)).toMatchObject({ newLeads: 1, newLeadsBasis: "created" });

    await expect(
      harness.t.mutation(internal.migrations.activateLeadStageReporting, { tenantId: harness.tenantId }),
    ).rejects.toThrow("assertLeadLifecycle");

    await run(harness, "backfillLeadLifecycle");
    await run(harness, "assertLeadLifecycle");
    await harness.t.mutation(internal.migrations.activateLeadStageReporting, { tenantId: harness.tenantId });

    expect(await report(OCTOBER)).toMatchObject({ newLeads: 0, newLeadsBasis: "reached_qualified" });
    expect(await report(SEPTEMBER)).toMatchObject({ newLeads: 1, newLeadsBasis: "reached_qualified" });

    await harness.t.mutation(internal.migrations.deactivateLeadStageReporting, { tenantId: harness.tenantId });
    expect(await report(OCTOBER)).toMatchObject({ newLeads: 1, newLeadsBasis: "created" });
  });

  it("won't switch while a lead split is still applying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const harness = await bookingHarness();
    migrationsTest.register(harness.t);
    await splitCreatedPerson(harness);
    await run(harness, "backfillLeadLifecycle");
    await run(harness, "assertLeadLifecycle");
    await harness.t.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").first())!;
      await ctx.db.insert("leadSplitPlans", {
        tenantId: harness.tenantId, sourceLeadId: lead._id, tier: "A", status: "applying", planVersion: 1,
        discoveryReasons: [], discoveredAt: 0, flags: [], flagDetails: [], placeholderIdentifierIds: [],
        unattributedMeetingIds: [], updatedAt: 0,
      });
    });

    await expect(
      harness.t.mutation(internal.migrations.activateLeadStageReporting, { tenantId: harness.tenantId }),
    ).rejects.toThrow("still applying");
  });

  it("a correction that leaves no evidence stops counting the person", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const harness = await bookingHarness();
    const qualifiedAt = Date.parse("2026-09-20T10:00:00Z");
    const result = await harness.t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        tenantId: harness.tenantId, status: "active", firstSeenAt: qualifiedAt, updatedAt: qualifiedAt,
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        tenantId: harness.tenantId, leadId, status: "qualified_pending", source: "slack_qualified",
        qualifiedAt, createdAt: qualifiedAt, updatedAt: qualifiedAt,
      });
      await correctLeadLifecycle(ctx, leadId, "lead_split");
      const counted = await countLeadStageEntries(ctx, harness.tenantId, "qualified", SEPTEMBER.startDate, SEPTEMBER.endDate);
      // The split moves the person's only deal elsewhere.
      await ctx.db.delete("opportunities", opportunityId);
      await correctLeadLifecycle(ctx, leadId, "lead_split");
      return {
        counted,
        after: await countLeadStageEntries(ctx, harness.tenantId, "qualified", SEPTEMBER.startDate, SEPTEMBER.endDate),
        lead: await ctx.db.get("leads", leadId),
      };
    });
    expect(result.counted).toBe(1);
    expect(result.after).toBe(0);
    expect(result.lead?.lifecycleStage).toBeUndefined();
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
