import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const ROWS = 101; // past one batch of 100

// The split's remaining record (docs/plans/polluted-lead-split.md §5.11).
it("deletes every row of the four split tables and leaves the lead alone", async () => {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const { tenantId } = harness;
  const leadId = await harness.t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId, status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const planId = await ctx.db.insert("leadSplitPlans", {
      tenantId, sourceLeadId: leadId, tier: "A", status: "applied", planVersion: 1, discoveryReasons: [],
      discoveredAt: 0, flags: [], flagDetails: [], placeholderIdentifierIds: [], unattributedMeetingIds: [],
      updatedAt: 0,
    });
    for (let index = 0; index < ROWS; index++) {
      if (index > 0) {
        await ctx.db.insert("leadSplitPlans", {
          tenantId, sourceLeadId: leadId, tier: "B", status: "dismissed", planVersion: 1, discoveryReasons: [],
          discoveredAt: 0, flags: [], flagDetails: [], placeholderIdentifierIds: [], unattributedMeetingIds: [],
          updatedAt: 0,
        });
      }
      await ctx.db.insert("leadSplitPersons", {
        tenantId, planId, planVersion: 1, personKey: `p${index}`, candidateKeys: [], role: "new",
        mergeCandidateLeadIds: [], meetingIds: [], identifierIds: [], slackEventIds: [], opportunityPlan: [],
        canonical: {}, status: "applied",
      });
      await ctx.db.insert("leadSplitAudit", {
        tenantId, planId, personKey: `p${index}`, step: "move", table: "leads", docId: leadId, op: "patch",
        createdAt: 0,
      });
      await ctx.db.insert("leadPlaceholderCleanups", {
        tenantId, leadId, table: "leads", docId: leadId, op: "patch", before: {}, approvedBy: "admin",
        createdAt: 0,
      });
    }
    return leadId;
  });

  await harness.t.mutation(internal.migrations.run, {
    fn: "migrations:deleteLeadSplitPersons",
    next: ["migrations:deleteLeadSplitAudit", "migrations:deleteLeadSplitPlans", "migrations:deleteLeadPlaceholderCleanups"],
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const state = await harness.t.run(async (ctx) => ({
    plans: await ctx.db.query("leadSplitPlans").take(1),
    persons: await ctx.db.query("leadSplitPersons").take(1),
    audit: await ctx.db.query("leadSplitAudit").take(1),
    cleanups: await ctx.db.query("leadPlaceholderCleanups").take(1),
    lead: await ctx.db.get("leads", leadId),
  }));
  expect(state).toMatchObject({ plans: [], persons: [], audit: [], cleanups: [] });
  expect(state.lead).not.toBeNull();
});
