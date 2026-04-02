import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent || rawEvent.processed) {
      return;
    }

    const scheduledEvent =
      isRecord(payload) && isRecord(payload.scheduled_event)
        ? payload.scheduled_event
        : null;
    const calendlyEventUri =
      (scheduledEvent ? getString(scheduledEvent, "uri") : undefined) ??
      (isRecord(payload) ? getString(payload, "event") : undefined);

    if (!calendlyEventUri) {
      console.error("[Pipeline] Missing event URI in invitee.canceled payload");
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri),
      )
      .unique();

    if (!meeting) {
      console.warn(
        `[Pipeline] No meeting found for canceled event URI: ${calendlyEventUri}`,
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    if (meeting.status !== "canceled") {
      await ctx.db.patch(meeting._id, { status: "canceled" });
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity) {
      const cancellation =
        isRecord(payload) && isRecord(payload.cancellation) ? payload.cancellation : null;
      const shouldMarkCanceled =
        opportunity.status === "canceled" ||
        validateTransition(opportunity.status, "canceled");

      await ctx.db.patch(opportunity._id, {
        status: shouldMarkCanceled ? "canceled" : opportunity.status,
        cancellationReason: cancellation ? getString(cancellation, "reason") : undefined,
        canceledBy:
          (cancellation ? getString(cancellation, "canceled_by") : undefined) ??
          (cancellation ? getString(cancellation, "canceler_type") : undefined),
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(rawEventId, { processed: true });
  },
});
