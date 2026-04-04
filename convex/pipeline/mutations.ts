import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Mark a raw webhook event as processed.
 * Used by the pipeline dispatcher for unhandled event types,
 * and as a fallback for edge cases.
 */
export const markProcessed = internalMutation({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    console.log(`[Pipeline] markProcessed | rawEventId=${rawEventId}`);
    await ctx.db.patch(rawEventId, { processed: true });
  },
});
