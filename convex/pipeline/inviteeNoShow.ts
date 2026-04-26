import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { cancelMeetingAttendanceCheck } from "../lib/attendanceChecks";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  replaceMeetingAggregate,
} from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

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

    // Log tracking presence for debugging (UTMs already stored at creation time)
    const hasTracking = isRecord(payload) && isRecord(payload.tracking);
    console.log(
      `[Pipeline:no-show] UTM check | hasTracking=${hasTracking}`
    );

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

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (meeting.status !== "meeting_overran") {
      await cancelMeetingAttendanceCheck(
        ctx,
        meeting.attendanceCheckId,
        "pipeline.inviteeNoShow",
      );
    }
    if (opportunity?.status === "meeting_overran") {
      const now = Date.now();
      console.log("[Pipeline:no-show] IGNORED - opportunity is meeting_overran", {
        opportunityId: opportunity._id,
        meetingId: meeting._id,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: meeting._id,
        eventType: "meeting.webhook_ignored_overran",
        source: "pipeline",
        occurredAt: now,
        metadata: {
          webhookEventType: "invitee_no_show.created",
          opportunityStatus: "meeting_overran",
        },
      });
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    const now = Date.now();
    if (meeting.status !== "no_show") {
      await ctx.db.patch(meeting._id, {
        status: "no_show",
        noShowSource: "calendly_webhook",
        noShowMarkedAt: now,
      });
      await replaceMeetingAggregate(ctx, meeting, meeting._id);
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: meeting._id,
        eventType: "meeting.no_show",
        source: "pipeline",
        fromStatus: meeting.status,
        toStatus: "no_show",
        occurredAt: now,
      });
      console.log(`[Pipeline:no-show] Meeting status changed | ${meeting.status} -> no_show`);
    } else {
      console.log(`[Pipeline:no-show] Meeting already no_show, no change`);
    }

    if (
      opportunity &&
      (opportunity.status === "scheduled" ||
        opportunity.status === "in_progress" ||
        opportunity.status === "no_show")
    ) {
      console.log(
        `[Pipeline:no-show] Opportunity status changed | opportunityId=${opportunity._id} ${opportunity.status} -> no_show`,
      );
      await patchOpportunityLifecycle(ctx, opportunity._id, {
        status: "no_show",
        noShowAt: now,
        updatedAt: now,
      });
      if (opportunity.status !== "no_show") {
        await updateTenantStats(ctx, tenantId, {
          activeOpportunities: isActiveOpportunityStatus(opportunity.status)
            ? -1
            : 0,
        });
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "opportunity",
          entityId: opportunity._id,
          eventType: "opportunity.status_changed",
          source: "pipeline",
          fromStatus: opportunity.status,
          toStatus: "no_show",
          occurredAt: now,
        });
      }
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

    // Log tracking presence for debugging
    const hasTracking = isRecord(payload) && isRecord(payload.tracking);
    console.log(
      `[Pipeline:no-show] Revert UTM check | hasTracking=${hasTracking}`
    );

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
      const now = Date.now();
      await ctx.db.patch(meeting._id, {
        status: "scheduled",
        noShowMarkedAt: undefined,
        noShowMarkedByUserId: undefined,
        noShowWaitDurationMs: undefined,
        noShowReason: undefined,
        noShowNote: undefined,
        noShowSource: undefined,
      });
      await replaceMeetingAggregate(ctx, meeting, meeting._id);
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: meeting._id,
        eventType: "meeting.no_show_reverted",
        source: "pipeline",
        fromStatus: "no_show",
        toStatus: "scheduled",
        occurredAt: now,
      });
      console.log(`[Pipeline:no-show] Revert: meeting status changed | no_show -> scheduled`);
    } else {
      console.log(`[Pipeline:no-show] Revert: meeting not in no_show status, no change`);
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity?.status === "no_show") {
      const now = Date.now();
      await patchOpportunityLifecycle(ctx, opportunity._id, {
        status: "scheduled",
        noShowAt: undefined,
        updatedAt: now,
      });
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: 1,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.status_changed",
        source: "pipeline",
        fromStatus: "no_show",
        toStatus: "scheduled",
        occurredAt: now,
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
