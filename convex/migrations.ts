import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { computeLatestActivityAt } from "./lib/opportunityActivity";
import { upsertOpportunitySearchProjection } from "./lib/opportunitySearch";

export const migrations = new Migrations<DataModel>(components.migrations);

export const run = migrations.runner();

export const backfillOpportunitySourceAndActivity = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const patch: {
      source?: "calendly";
      latestActivityAt?: number;
    } = {};

    if (opportunity.source === undefined) {
      patch.source = "calendly";
    }

    if (opportunity.latestActivityAt === undefined) {
      patch.latestActivityAt = computeLatestActivityAt(opportunity);
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(opportunity._id, patch);
    }
  },
});

export const assertOpportunitySourceAndActivityBackfilled = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (_ctx, opportunity) => {
    if (opportunity.source === undefined) {
      throw new Error(`Opportunity ${opportunity._id} is missing source`);
    }
    if (opportunity.latestActivityAt === undefined) {
      throw new Error(
        `Opportunity ${opportunity._id} is missing latestActivityAt`,
      );
    }
  },
});

export const backfillOpportunitySearchProjection = migrations.define({
  table: "opportunities",
  batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    await upsertOpportunitySearchProjection(ctx, opportunity._id);
  },
});

export const assertOpportunitySearchProjectionBackfilled = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const projection = await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .unique();

    if (!projection) {
      throw new Error(
        `Opportunity ${opportunity._id} is missing an opportunitySearch projection`,
      );
    }
    if (
      projection.tenantId !== opportunity.tenantId ||
      projection.leadId !== opportunity.leadId ||
      projection.status !== opportunity.status
    ) {
      throw new Error(
        `Opportunity ${opportunity._id} has a stale opportunitySearch projection`,
      );
    }
  },
});
