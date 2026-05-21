import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentBookingHealthIssues = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const events = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_receivedAt", (q) =>
        q.eq("tenantId", tenantId).gte("receivedAt", since),
      )
      .order("desc")
      .take(100);

    return events
      .filter((event) => event.eventType === "invitee.created" && !event.processed)
      .slice(0, 25)
      .map((event) => ({
        rawEventId: event._id,
        receivedAt: event.receivedAt,
        calendlyEventUri: event.calendlyEventUri,
        issue: "unprocessed_invitee_created" as const,
      }));
  },
});
