import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import {
  clearBillingPaymentAggregatesForTenant,
  insertBillingPaymentAggregates,
} from "./aggregates";

const BACKFILL_BATCH_SIZE = 200;

export const backfillBillingPaymentAggregates = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.optional(v.string()),
    reset: v.optional(v.boolean()),
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, { tenantId, cursor, reset, startedAt }) => {
    const backfillStartedAt = startedAt ?? Date.now();

    if (reset === true && cursor === undefined) {
      await clearBillingPaymentAggregatesForTenant(ctx, tenantId);
    }

    const result = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .paginate({
        numItems: BACKFILL_BATCH_SIZE,
        cursor: cursor ?? null,
      });

    for (const payment of result.page) {
      await insertBillingPaymentAggregates(ctx, payment);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.backfill.backfillBillingPaymentAggregates,
        {
          tenantId,
          cursor: result.continueCursor,
          startedAt: backfillStartedAt,
        },
      );
    }

    return {
      processed: result.page.length,
      insertedOrAlreadyPresent: result.page.length,
      hasMore: !result.isDone,
      startedAt: backfillStartedAt,
      completedAt: result.isDone ? Date.now() : null,
    };
  },
});
