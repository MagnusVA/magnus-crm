import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
export async function buildBookingHealthIssues(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const events = await ctx.db
    .query("rawWebhookEvents")
    .withIndex("by_tenantId_and_receivedAt", (q) =>
      q.eq("tenantId", tenantId).gte("receivedAt", since),
    )
    .order("desc")
    .take(100);

  return events
    .filter(
      (event) => event.eventType === "invitee.created" && !event.processed,
    )
    .slice(0, 25)
    .map((event) => ({
      rawEventId: event._id,
      receivedAt: event.receivedAt,
      calendlyEventUri: event.calendlyEventUri,
      issue: "unprocessed_invitee_created" as const,
    }));
}
