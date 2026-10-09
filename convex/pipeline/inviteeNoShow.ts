import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  validateMeetingTransition,
  validateTransition,
} from "../lib/statusTransitions";
import {
  replaceMeetingAggregate,
} from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { log, reportError } from "../lib/observability/log";
import { classifyMissingMeeting } from "./missingMeeting";

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
    const rawEvent = await ctx.db.get("rawWebhookEvents", rawEventId);
    if (!rawEvent || rawEvent.processed) {
      log.info("pipeline.invitee_no_show.skipped", {
        reason: rawEvent ? "already_processed" : "raw_event_missing",
        tenantId,
        rawEventId,
      });
      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);

    if (!calendlyEventUri) {
      reportError(
        "pipeline.event_dropped",
        new Error("invitee_no_show.created payload has no scheduled event URI"),
        {
          severity: "warning",
          fingerprint:
            "pipeline.event_dropped:invitee_no_show.created:missing_event_uri",
          integration: "calendly",
          reason: "missing_event_uri",
          eventType: "invitee_no_show.created",
          tenantId,
          rawEventId,
        },
      );
      await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
      return;
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri),
      )
      .unique();

    if (!meeting) {
      const reason = await classifyMissingMeeting(ctx, rawEvent);
      if (reason === "booking_not_tracked") {
        // The booking was deliberately not tracked (non-closer host).
        log.info("pipeline.invitee_no_show.skipped", {
          reason,
          tenantId,
          rawEventId,
        });
      } else {
        reportError(
          "pipeline.event_dropped",
          new Error(
            reason === "out_of_order"
              ? "invitee_no_show.created arrived before its invitee.created was processed"
              : "invitee_no_show.created has no matching meeting",
          ),
          {
            severity: "warning",
            fingerprint: `pipeline.event_dropped:invitee_no_show.created:${reason}`,
            integration: "calendly",
            reason,
            eventType: "invitee_no_show.created",
            tenantId,
            rawEventId,
            calendlyEventUri,
          },
        );
      }
      await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
      return;
    }

    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);

    const now = Date.now();
    let meetingTransition: "applied" | "invalid" | "already_no_show" =
      "already_no_show";
    let opportunityMarkedNoShow = false;
    if (meeting.status !== "no_show") {
      if (validateMeetingTransition(meeting.status, "no_show")) {
        meetingTransition = "applied";
        await ctx.db.patch("meetings", meeting._id, {
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
      } else {
        meetingTransition = "invalid";
      }
    }

    if (
      opportunity &&
      (opportunity.status === "no_show" ||
        validateTransition(opportunity.status, "no_show"))
    ) {
      opportunityMarkedNoShow = true;
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
    } else if (!opportunity) {
      reportError(
        "pipeline.data_inconsistency",
        new Error("Meeting references a missing opportunity"),
        {
          severity: "error",
          fingerprint: "pipeline.data_inconsistency:meeting_opportunity_missing",
          reason: "meeting_opportunity_missing",
          eventType: "invitee_no_show.created",
          tenantId,
          rawEventId,
          meetingId: meeting._id,
          opportunityId: meeting.opportunityId,
        },
      );
    }

    await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
    log.info("pipeline.invitee_no_show.processed", {
      tenantId,
      rawEventId,
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      previousMeetingStatus: meeting.status,
      meetingTransition,
      opportunityFound: opportunity !== null,
      previousOpportunityStatus: opportunity?.status,
      opportunityMarkedNoShow,
    });
  },
});

export const revert = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    const rawEvent = await ctx.db.get("rawWebhookEvents", rawEventId);
    if (!rawEvent || rawEvent.processed) {
      log.info("pipeline.invitee_no_show_reverted.skipped", {
        reason: rawEvent ? "already_processed" : "raw_event_missing",
        tenantId,
        rawEventId,
      });
      return;
    }

    const calendlyEventUri = extractCalendlyEventUri(payload);

    if (!calendlyEventUri) {
      reportError(
        "pipeline.event_dropped",
        new Error("invitee_no_show.deleted payload has no scheduled event URI"),
        {
          severity: "warning",
          fingerprint:
            "pipeline.event_dropped:invitee_no_show.deleted:missing_event_uri",
          integration: "calendly",
          reason: "missing_event_uri",
          eventType: "invitee_no_show.deleted",
          tenantId,
          rawEventId,
        },
      );
      await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
      return;
    }

    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri),
      )
      .unique();

    if (!meeting) {
      const reason = await classifyMissingMeeting(ctx, rawEvent);
      if (reason === "booking_not_tracked") {
        // The booking was deliberately not tracked (non-closer host).
        log.info("pipeline.invitee_no_show_reverted.skipped", {
          reason,
          tenantId,
          rawEventId,
        });
      } else {
        reportError(
          "pipeline.event_dropped",
          new Error(
            reason === "out_of_order"
              ? "invitee_no_show.deleted arrived before its invitee.created was processed"
              : "invitee_no_show.deleted has no matching meeting",
          ),
          {
            severity: "warning",
            fingerprint: `pipeline.event_dropped:invitee_no_show.deleted:${reason}`,
            integration: "calendly",
            reason,
            eventType: "invitee_no_show.deleted",
            tenantId,
            rawEventId,
            calendlyEventUri,
          },
        );
      }
      await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
      return;
    }

    if (meeting.status === "no_show") {
      const now = Date.now();
      await ctx.db.patch("meetings", meeting._id, {
        status: "scheduled",
        noShowMarkedAt: undefined,
        noShowMarkedByUserId: undefined,
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
    }

    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
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
    } else if (!opportunity) {
      reportError(
        "pipeline.data_inconsistency",
        new Error("Meeting references a missing opportunity"),
        {
          severity: "error",
          fingerprint: "pipeline.data_inconsistency:meeting_opportunity_missing",
          reason: "meeting_opportunity_missing",
          eventType: "invitee_no_show.deleted",
          tenantId,
          rawEventId,
          meetingId: meeting._id,
          opportunityId: meeting.opportunityId,
        },
      );
    }

    await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
    log.info("pipeline.invitee_no_show_reverted.processed", {
      tenantId,
      rawEventId,
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      previousMeetingStatus: meeting.status,
      meetingReverted: meeting.status === "no_show",
      opportunityFound: opportunity !== null,
      previousOpportunityStatus: opportunity?.status,
      opportunityReverted: opportunity?.status === "no_show",
    });
  },
});
