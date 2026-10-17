import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { leadStageTotals } from "../lib/leadLifecycle";

// Read-only checks for the lifecycle backfill (docs/plans/phase-1-foundations.md
// §9.2): how many people `leadStageEntries` holds at each stage, to compare
// with a scan of the leads.
export const stageTotals = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => await leadStageTotals(ctx, tenantId),
});
