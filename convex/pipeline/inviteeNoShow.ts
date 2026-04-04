import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";

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
    console.log(`[Pipeline:no-show] Entry (process) | tenantId=${tenantId} rawEventId=${rawEventId}`);

    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent || rawEvent.processed) {
      console.log(`[Pipeline:no-show] Skipping: event already processed or not found`);
      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);
    console.log(`[Pipeline:no-show] Extracted eventUri=${calendlyEventUri ?? "none"}`);

    if (!calendlyEventUri) {
      console.error("[Pipeline:no-show] Missing event URI in invitee_no_show.created payload");
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
        `[Pipeline:no-show] No meeting found for eventUri=${calendlyEventUri}`,
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    console.log(
      `[Pipeline:no-show] Meeting found | meetingId=${meeting._id} currentStatus=${meeting.status}`,
    );

    if (meeting.status !== "no_show") {
      await ctx.db.patch(meeting._id, { status: "no_show" });
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      console.log(`[Pipeline:no-show] Meeting status changed | ${meeting.status} -> no_show`);
    } else {
      console.log(`[Pipeline:no-show] Meeting already no_show, no change`);
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (
      opportunity &&
      (opportunity.status === "scheduled" ||
        opportunity.status === "in_progress" ||
        opportunity.status === "no_show")
    ) {
      console.log(
        `[Pipeline:no-show] Opportunity status changed | opportunityId=${opportunity._id} ${opportunity.status} -> no_show`,
      );
      await ctx.db.patch(opportunity._id, {
        status: "no_show",
        updatedAt: Date.now(),
      });
    } else if (opportunity) {
      console.log(
        `[Pipeline:no-show] Opportunity not eligible for no_show transition | opportunityId=${opportunity._id} currentStatus=${opportunity.status}`,
      );
    } else {
      console.warn(`[Pipeline:no-show] Opportunity not found for meeting ${meeting._id}`);
    }

    await ctx.db.patch(rawEventId, { processed: true });
    console.log(`[Pipeline:no-show] Marked processed | rawEventId=${rawEventId}`);
  },
});

export const revert = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    console.log(`[Pipeline:no-show] Entry (revert) | tenantId=${tenantId} rawEventId=${rawEventId}`);
    console.log(`[Pipeline:no-show] No-show is being reversed`);

    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent || rawEvent.processed) {
      console.log(`[Pipeline:no-show] Revert skipping: event already processed or not found`);
      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);
    console.log(`[Pipeline:no-show] Revert extracted eventUri=${calendlyEventUri ?? "none"}`);

    if (!calendlyEventUri) {
      console.warn(`[Pipeline:no-show] Revert: missing event URI, marking processed`);
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
      console.warn(`[Pipeline:no-show] Revert: no meeting found for eventUri=${calendlyEventUri}`);
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    console.log(
      `[Pipeline:no-show] Revert: meeting found | meetingId=${meeting._id} currentStatus=${meeting.status}`,
    );

    if (meeting.status === "no_show") {
      await ctx.db.patch(meeting._id, { status: "scheduled" });
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      console.log(`[Pipeline:no-show] Revert: meeting status changed | no_show -> scheduled`);
    } else {
      console.log(`[Pipeline:no-show] Revert: meeting not in no_show status, no change`);
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity?.status === "no_show") {
      await ctx.db.patch(opportunity._id, {
        status: "scheduled",
        updatedAt: Date.now(),
      });
      console.log(
        `[Pipeline:no-show] Revert: opportunity status changed | opportunityId=${opportunity._id} no_show -> scheduled`,
      );
    } else if (opportunity) {
      console.log(
        `[Pipeline:no-show] Revert: opportunity not in no_show status | opportunityId=${opportunity._id} currentStatus=${opportunity.status}`,
      );
    } else {
      console.warn(`[Pipeline:no-show] Revert: opportunity not found for meeting ${meeting._id}`);
    }

    await ctx.db.patch(rawEventId, { processed: true });
    console.log(`[Pipeline:no-show] Revert: marked processed | rawEventId=${rawEventId}`);
  },
});
