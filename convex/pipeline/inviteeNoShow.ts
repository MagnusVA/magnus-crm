import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractCalendlyEventUri(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (isRecord(payload.scheduled_event)) {
    const scheduledEventUri = getString(payload.scheduled_event, "uri");
    if (scheduledEventUri) {
      return scheduledEventUri;
    }
  }

  return getString(payload, "event");
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

    const calendlyEventUri = extractCalendlyEventUri(payload);
    if (!calendlyEventUri) {
      console.error("[Pipeline] Missing event URI in invitee_no_show.created payload");
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
        `[Pipeline] No meeting found for no-show event URI: ${calendlyEventUri}`,
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    if (meeting.status !== "no_show") {
      await ctx.db.patch(meeting._id, { status: "no_show" });
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (
      opportunity &&
      (opportunity.status === "scheduled" ||
        opportunity.status === "in_progress" ||
        opportunity.status === "no_show")
    ) {
      await ctx.db.patch(opportunity._id, {
        status: "no_show",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(rawEventId, { processed: true });
  },
});

export const revert = internalMutation({
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

    const calendlyEventUri = extractCalendlyEventUri(payload);
    if (!calendlyEventUri) {
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
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    if (meeting.status === "no_show") {
      await ctx.db.patch(meeting._id, { status: "scheduled" });
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity?.status === "no_show") {
      await ctx.db.patch(opportunity._id, {
        status: "scheduled",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(rawEventId, { processed: true });
  },
});
