import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { cancelMeetingAttendanceCheck } from "../lib/attendanceChecks";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { validateTransition } from "../lib/statusTransitions";
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
		console.log(
			`[Pipeline:invitee.canceled] Entry | tenantId=${tenantId} rawEventId=${rawEventId}`,
		);

		const rawEvent = await ctx.db.get(rawEventId);
		if (!rawEvent || rawEvent.processed) {
			console.log(
				`[Pipeline:invitee.canceled] Skipping: event already processed or not found`,
			);
			return;
		}

		// Log tracking presence for debugging (UTMs already stored at creation time)
		const hasTracking = isRecord(payload) && isRecord(payload.tracking);
		console.log(
			`[Pipeline:invitee.canceled] UTM check | hasTracking=${hasTracking}`,
		);

		const scheduledEvent =
			isRecord(payload) && isRecord(payload.scheduled_event)
				? payload.scheduled_event
				: null;
		const calendlyEventUri =
			(scheduledEvent ? getString(scheduledEvent, "uri") : undefined) ??
			(isRecord(payload) ? getString(payload, "event") : undefined);

		console.log(
			`[Pipeline:invitee.canceled] Extracted eventUri=${calendlyEventUri ?? "none"}`,
		);

		if (!calendlyEventUri) {
			console.error(
				"[Pipeline:invitee.canceled] Missing event URI in payload",
			);
			await ctx.db.patch(rawEventId, { processed: true });
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
			console.warn(
				`[Pipeline:invitee.canceled] No meeting found for eventUri=${calendlyEventUri}`,
			);
			await ctx.db.patch(rawEventId, { processed: true });
			return;
		}

		console.log(
			`[Pipeline:invitee.canceled] Meeting found | meetingId=${meeting._id} currentStatus=${meeting.status}`,
		);

		const opportunity = await ctx.db.get(meeting.opportunityId);
		if (meeting.status !== "meeting_overran") {
			await cancelMeetingAttendanceCheck(
				ctx,
				meeting.attendanceCheckId,
				"pipeline.inviteeCanceled",
			);
		}
		if (opportunity?.status === "meeting_overran") {
			const now = Date.now();
			console.log(
				"[Pipeline:invitee.canceled] IGNORED - opportunity is meeting_overran",
				{
					opportunityId: opportunity._id,
					meetingId: meeting._id,
				},
			);
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "meeting",
				entityId: meeting._id,
				eventType: "meeting.webhook_ignored_overran",
				source: "pipeline",
				occurredAt: now,
				metadata: {
					webhookEventType: "invitee.canceled",
					opportunityStatus: "meeting_overran",
				},
			});
			await ctx.db.patch(rawEventId, { processed: true });
			return;
		}

		if (meeting.status !== "canceled") {
			const now = Date.now();
			await ctx.db.patch(meeting._id, {
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
			console.log(
				`[Pipeline:invitee.canceled] Meeting status changed | ${meeting.status} -> canceled`,
			);
		} else {
			console.log(
				`[Pipeline:invitee.canceled] Meeting already canceled, no change`,
			);
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
			console.log(
				`[Pipeline:invitee.canceled] Opportunity update | opportunityId=${opportunity._id} statusTransition=${opportunity.status}->${newStatus} reason=${cancellationReason ?? "none"} canceledBy=${canceledBy ?? "unknown"}`,
			);

			const now = Date.now();
			await patchOpportunityLifecycle(ctx, opportunity._id, {
				status: newStatus,
				cancellationReason,
				canceledBy,
				canceledAt: newStatus === "canceled" ? now : opportunity.canceledAt,
				updatedAt: now,
			});
			if (newStatus !== opportunity.status) {
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
			console.warn(
				`[Pipeline:invitee.canceled] Opportunity not found for meeting ${meeting._id}`,
			);
		}

		await ctx.db.patch(rawEventId, { processed: true });
		console.log(
			`[Pipeline:invitee.canceled] Marked processed | rawEventId=${rawEventId}`,
		);
	},
});
