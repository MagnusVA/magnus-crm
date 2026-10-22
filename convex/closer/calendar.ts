import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { isMissedMeetingLoss } from "../opportunities/dealState";
import { dealPosition, dealStageOf } from "../opportunities/stages";

/**
 * Get all of a closer's meetings within a date range, canceled ones
 * included (docs/plans/phase-5-deal-status.md §6.3).
 *
 * Each meeting comes with the person's name, its event type, its deal's
 * position and, for a deal a no-show or cancellation closed, which one.
 * Used by the calendar view to render meeting blocks.
 *
 * Args:
 * - startDate: Unix ms timestamp for the start of the range
 * - endDate: Unix ms timestamp for the end of the range
 */
export const getMeetingsForRange = query({
	args: {
		startDate: v.number(),
		endDate: v.number(),
	},
	handler: async (ctx, { startDate, endDate }) => {
		if (startDate >= endDate) {
			throw new Error("startDate must be earlier than endDate");
		}

		const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

		const myMeetings: Array<Doc<"meetings">> = [];
		for await (const meeting of ctx.db
			.query("meetings")
			.withIndex(
				"by_tenantId_and_assignedCloserId_and_scheduledAt",
				(q) =>
					q
						.eq("tenantId", tenantId)
						.eq("assignedCloserId", userId)
						.gte("scheduledAt", startDate)
						.lt("scheduledAt", endDate),
			)) {
			myMeetings.push(meeting);
		}

		if (myMeetings.length === 0) {
			return [];
		}

		const opportunityIds = [
			...new Set(myMeetings.map((meeting) => meeting.opportunityId)),
		];
		const opportunities = await Promise.all(
			opportunityIds.map(async (opportunityId) => ({
				opportunityId,
				opportunity: await ctx.db.get("opportunities", opportunityId),
			})),
		);
		const opportunityById = new Map<
			Id<"opportunities">,
			Doc<"opportunities">
		>();
		const eventTypeConfigIds = new Set<Id<"eventTypeConfigs">>();

		for (const { opportunityId, opportunity } of opportunities) {
			if (!opportunity || opportunity.tenantId !== tenantId) {
				continue;
			}
			opportunityById.set(opportunityId, opportunity);
			if (opportunity.eventTypeConfigId) {
				eventTypeConfigIds.add(opportunity.eventTypeConfigId);
			}
		}

		const eventTypeConfigs = await Promise.all(
			[...eventTypeConfigIds].map(async (eventTypeConfigId) => ({
				eventTypeConfigId,
				eventTypeConfig: await ctx.db.get("eventTypeConfigs", eventTypeConfigId),
			})),
		);
		const eventTypeNameById = new Map<
			Id<"eventTypeConfigs">,
			string | null
		>(
			eventTypeConfigs.map(({ eventTypeConfigId, eventTypeConfig }) => [
				eventTypeConfigId,
				eventTypeConfig?.displayName ?? null,
			]),
		);

		return myMeetings.map((meeting) => {
			const opportunity = opportunityById.get(meeting.opportunityId);
			const eventTypeName = opportunity?.eventTypeConfigId
				? (eventTypeNameById.get(opportunity.eventTypeConfigId) ?? null)
				: null;
			const deal = opportunity ? dealStageOf(opportunity) : null;

			return {
				// What a block draws; the meeting's copy of the deal status stays out.
				meeting: {
					_id: meeting._id,
					scheduledAt: meeting.scheduledAt,
					durationMinutes: meeting.durationMinutes,
					status: meeting.status,
					meetingJoinUrl: meeting.meetingJoinUrl,
					zoomJoinUrl: meeting.zoomJoinUrl,
				},
				leadName: meeting.leadName ?? "Unknown",
				eventTypeName,
				dealPosition: deal ? dealPosition(deal.stage, deal.outcome) : null,
				missedMeeting: opportunity ? isMissedMeetingLoss(opportunity) : null,
			};
		});
	},
});
