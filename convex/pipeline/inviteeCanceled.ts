import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
	validateMeetingTransition,
	validateTransition,
} from "../lib/statusTransitions";
import { emitDomainEvent } from "../lib/domainEvents";
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

function getString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
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
		const rawEvent = await ctx.db.get("rawWebhookEvents", rawEventId);
		if (!rawEvent || rawEvent.processed) {
			log.info("pipeline.invitee_canceled.skipped", {
				reason: rawEvent ? "already_processed" : "raw_event_missing",
				tenantId,
				rawEventId,
			});
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
			reportError(
				"pipeline.event_dropped",
				new Error("invitee.canceled payload has no scheduled event URI"),
				{
					severity: "warning",
					fingerprint: "pipeline.event_dropped:invitee.canceled:missing_event_uri",
					integration: "calendly",
					reason: "missing_event_uri",
					eventType: "invitee.canceled",
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
				q
					.eq("tenantId", tenantId)
					.eq("calendlyEventUri", calendlyEventUri),
			)
			.unique();

		if (!meeting) {
			const reason = await classifyMissingMeeting(ctx, rawEvent);
			if (reason === "booking_not_tracked") {
				// The booking was deliberately not tracked (non-closer host).
				log.info("pipeline.invitee_canceled.skipped", {
					reason,
					tenantId,
					rawEventId,
				});
			} else {
				// The cancellation is lost either way.
				reportError(
					"pipeline.event_dropped",
					new Error(
						reason === "out_of_order"
							? "invitee.canceled arrived before its invitee.created was processed"
							: "invitee.canceled has no matching meeting",
					),
					{
						severity: "warning",
						fingerprint: `pipeline.event_dropped:invitee.canceled:${reason}`,
						integration: "calendly",
						reason,
						eventType: "invitee.canceled",
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

		let meetingTransition: "applied" | "invalid" | "already_canceled" =
			"already_canceled";
		let opportunityStatusChange: { from: string; to: string } | undefined;
		if (meeting.status !== "canceled") {
			const now = Date.now();
			if (validateMeetingTransition(meeting.status, "canceled")) {
				await ctx.db.patch("meetings", meeting._id, {
					status: "canceled",
					canceledAt: now,
				});
				await replaceMeetingAggregate(ctx, meeting, meeting._id);
				await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
				await emitDomainEvent(ctx, {
					tenantId,
					entityType: "meeting",
					entityId: meeting._id,
					eventType: "meeting.canceled",
					source: "pipeline",
					fromStatus: meeting.status,
					toStatus: "canceled",
					occurredAt: now,
				});
				meetingTransition = "applied";
			} else {
				meetingTransition = "invalid";
			}
		}

		if (opportunity) {
			const cancellation =
				isRecord(payload) && isRecord(payload.cancellation)
					? payload.cancellation
					: null;
			const cancellationReason = cancellation
				? getString(cancellation, "reason")
				: undefined;
			const canceledBy =
				(cancellation
					? getString(cancellation, "canceled_by")
					: undefined) ??
				(cancellation
					? getString(cancellation, "canceler_type")
					: undefined);
			const shouldMarkCanceled =
				opportunity.status === "canceled" ||
				validateTransition(opportunity.status, "canceled");

			const newStatus = shouldMarkCanceled
				? "canceled"
				: opportunity.status;

			const now = Date.now();
			await patchOpportunityLifecycle(ctx, opportunity._id, {
				status: newStatus,
				cancellationReason,
				canceledBy,
				canceledAt: newStatus === "canceled" ? now : opportunity.canceledAt,
				updatedAt: now,
			});
			if (newStatus !== opportunity.status) {
				opportunityStatusChange = { from: opportunity.status, to: newStatus };
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
					toStatus: newStatus,
					reason: cancellationReason,
					metadata: { canceledBy },
					occurredAt: now,
				});
			}
		} else {
			reportError(
				"pipeline.data_inconsistency",
				new Error("Meeting references a missing opportunity"),
				{
					severity: "error",
					fingerprint: "pipeline.data_inconsistency:meeting_opportunity_missing",
					reason: "meeting_opportunity_missing",
					eventType: "invitee.canceled",
					tenantId,
					rawEventId,
					meetingId: meeting._id,
					opportunityId: meeting.opportunityId,
				},
			);
		}

		await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
		log.info("pipeline.invitee_canceled.processed", {
			tenantId,
			rawEventId,
			meetingId: meeting._id,
			opportunityId: meeting.opportunityId,
			previousMeetingStatus: meeting.status,
			meetingTransition,
			opportunityFound: opportunity !== null,
			previousOpportunityStatus: opportunityStatusChange?.from,
			opportunityStatus: opportunityStatusChange?.to ?? opportunity?.status,
		});
	},
});
