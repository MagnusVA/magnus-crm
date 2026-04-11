import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";

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

		if (meeting.status !== "canceled") {
			await ctx.db.patch(meeting._id, { status: "canceled" });
			await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
			console.log(
				`[Pipeline:invitee.canceled] Meeting status changed | ${meeting.status} -> canceled`,
			);
		} else {
			console.log(
				`[Pipeline:invitee.canceled] Meeting already canceled, no change`,
			);
		}

		const opportunity = await ctx.db.get(meeting.opportunityId);
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

			await ctx.db.patch(opportunity._id, {
				status: newStatus,
				cancellationReason,
				canceledBy,
				updatedAt: Date.now(),
			});
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
