import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";

/** Old internal entry points use the same stored payload and receipt contract. */
export async function applyStoredBookingFact(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    rawEventId: Id<"rawWebhookEvents">;
    payload: unknown;
  },
  eventType: string,
) {
  const raw = await ctx.db.get("rawWebhookEvents", args.rawEventId);
  if (!raw || raw.tenantId !== args.tenantId || raw.eventType !== eventType)
    throw new Error("Invalid stored webhook");
  await ctx.runMutation(internal.pipeline.processor.processRawEvent, {
    rawEventId: raw._id,
  });
}
