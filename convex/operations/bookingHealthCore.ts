import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function buildBookingHealthIssues(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const queued = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_status_and_queuedAt", (q) =>
      q.eq("tenantId", tenantId)
        .eq("status", "queued")
        .gte("queuedAt", 0)
        .lt("queuedAt", cutoff),
    )
    .take(25);
  const legacy = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_status_and_queuedAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", "queued").eq("queuedAt", undefined),
    )
    .take(101);
  const failed = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", "failed"),
    )
    .take(25);
  const blocked = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", "blocked"),
    )
    .take(25);

  return [
    ...failed,
    ...queued,
    ...legacy.filter((receipt) => receipt.receivedAt < cutoff),
    ...blocked,
  ]
    .slice(0, 25)
    .map((receipt) => ({
      rawEventId: receipt.rawEventId,
      receivedAt: receipt.receivedAt,
      calendlyEventUri: receipt.inviteeUri,
      issue:
        receipt.status === "blocked"
          ? ("bookings_held" as const)
          : receipt.status === "failed"
            ? ("delivery_failed" as const)
            : ("unprocessed_invitee_created" as const),
      severity:
        receipt.status === "blocked" ? ("warning" as const) : ("error" as const),
    }));
}
