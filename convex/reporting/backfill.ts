import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import {
	normalizePaymentOrigin,
	type PaymentOrigin,
} from "../lib/paymentTypes";
import {
	customerConversions,
	leadTimeline,
	meetingsByStatus,
	opportunityByStatus,
	paymentSums,
} from "./aggregates";

const CLASSIFICATION_PAGE_SIZE = 100;
const AGGREGATE_PAGE_SIZE = 200;
const ORIGIN_BACKFILL_PAGE_SIZE = 100;

type FollowUpCreatedSource = "closer" | "admin" | "system";

export const backfillMeetingClassification = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("meetings").paginate({
			numItems: CLASSIFICATION_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		let updated = 0;
		for (const meeting of result.page) {
			if (meeting.callClassification !== undefined) {
				continue;
			}

			const firstMeeting = await ctx.db
				.query("meetings")
				.withIndex("by_opportunityId_and_scheduledAt", (q) =>
					q.eq("opportunityId", meeting.opportunityId),
				)
				.first();

			await ctx.db.patch(meeting._id, {
				callClassification:
					firstMeeting === null || firstMeeting._id === meeting._id
						? "new"
						: "follow_up",
			});
			updated += 1;
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillMeetingClassification,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			processed: result.page.length,
			updated,
		};
	},
});

export const backfillMeetingsAggregate = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("meetings").paginate({
			numItems: AGGREGATE_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		for (const meeting of result.page) {
			await meetingsByStatus.insertIfDoesNotExist(ctx, meeting);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillMeetingsAggregate,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			inserted: result.page.length,
		};
	},
});

export const backfillPaymentsAggregate = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("paymentRecords").paginate({
			numItems: AGGREGATE_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		for (const payment of result.page) {
			await paymentSums.insertIfDoesNotExist(ctx, payment);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillPaymentsAggregate,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			inserted: result.page.length,
		};
	},
});

export const backfillOpportunitiesAggregate = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("opportunities").paginate({
			numItems: AGGREGATE_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		for (const opportunity of result.page) {
			await opportunityByStatus.insertIfDoesNotExist(ctx, opportunity);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillOpportunitiesAggregate,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			inserted: result.page.length,
		};
	},
});

export const backfillLeadsAggregate = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("leads").paginate({
			numItems: AGGREGATE_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		for (const lead of result.page) {
			await leadTimeline.insertIfDoesNotExist(ctx, lead);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillLeadsAggregate,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			inserted: result.page.length,
		};
	},
});

export const backfillCustomersAggregate = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("customers").paginate({
			numItems: AGGREGATE_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		for (const customer of result.page) {
			await customerConversions.insertIfDoesNotExist(ctx, customer);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillCustomersAggregate,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			inserted: result.page.length,
		};
	},
});

export const backfillPaymentOrigin = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("paymentRecords").paginate({
			numItems: ORIGIN_BACKFILL_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		let updated = 0;
		let skipped = 0;
		let defaultedToCloserMeeting = 0;

		for (const payment of result.page) {
			if (payment.origin) {
				skipped += 1;
				continue;
			}

			let origin: PaymentOrigin =
				payment.contextType === "customer"
					? "customer_direct"
					: "closer_meeting";
			let usedDefault = false;

			const events = await ctx.db
				.query("domainEvents")
				.withIndex(
					"by_tenantId_and_entityType_and_entityId_and_occurredAt",
					(q) =>
						q
							.eq("tenantId", payment.tenantId)
							.eq("entityType", "payment")
							.eq("entityId", payment._id),
				)
				.take(5);
			const recordedEvent =
				events.find(
					(event) => event.eventType === "payment.recorded",
				) ?? null;

			if (recordedEvent && payment.contextType !== "customer") {
				if (recordedEvent.source === "admin") {
					origin = "admin_meeting";
				} else if (recordedEvent.source === "closer") {
					origin = "closer_meeting";
				} else {
					origin = "closer_meeting";
					usedDefault = true;
				}
			} else if (payment.contextType !== "customer") {
				usedDefault = true;
			}

			if (usedDefault) {
				defaultedToCloserMeeting += 1;
			}

			await ctx.db.patch(payment._id, { origin });
			updated += 1;
		}

		if (defaultedToCloserMeeting > 0) {
			console.log(
				"[Backfill:PaymentOrigin] batch complete | updated=%d skipped=%d defaulted=%d",
				updated,
				skipped,
				defaultedToCloserMeeting,
			);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillPaymentOrigin,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			updated,
			skipped,
			defaultedToCloserMeeting,
		};
	},
});

export const auditPaymentOriginBackfill = internalQuery({
	args: {},
	handler: async (ctx) => {
		let cursor: string | null = null;
		let total = 0;
		let withOrigin = 0;
		let adminAttributed = 0;
		const byOrigin: Record<PaymentOrigin, number> = {
			closer_meeting: 0,
			closer_reminder: 0,
			admin_meeting: 0,
			admin_reminder: 0,
			admin_review_resolution: 0,
			closer_side_deal: 0,
			admin_side_deal: 0,
			customer_direct: 0,
			bookkeeper_direct: 0,
		};

		while (true) {
			const result = await ctx.db.query("paymentRecords").paginate({
				numItems: 500,
				cursor,
			});

			for (const payment of result.page) {
				total += 1;

				if (payment.origin) {
					withOrigin += 1;
					byOrigin[
						normalizePaymentOrigin(
							payment.origin,
							payment.contextType,
						)
					] += 1;
				}
				if (payment.origin?.startsWith("admin_")) {
					adminAttributed += 1;
				}
			}

			if (result.isDone) {
				break;
			}
			cursor = result.continueCursor;
		}

		return {
			total,
			withOrigin,
			unset: total - withOrigin,
			adminAttributed,
			byOrigin,
		};
	},
});

export const backfillFollowUpOrigin = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query("followUps").paginate({
			numItems: ORIGIN_BACKFILL_PAGE_SIZE,
			cursor: cursor ?? null,
		});

		let updated = 0;
		let skipped = 0;
		let defaultedToSystem = 0;

		for (const followUp of result.page) {
			const alreadyBackfilled =
				followUp.createdSource === "system" ||
				(followUp.createdSource !== undefined &&
					followUp.createdByUserId !== undefined);
			if (alreadyBackfilled) {
				skipped += 1;
				continue;
			}

			let createdSource = followUp.createdSource;
			let createdByUserId = followUp.createdByUserId;
			let defaulted = false;

			const events = await ctx.db
				.query("domainEvents")
				.withIndex(
					"by_tenantId_and_entityType_and_entityId_and_occurredAt",
					(q) =>
						q
							.eq("tenantId", followUp.tenantId)
							.eq("entityType", "followUp")
							.eq("entityId", followUp._id),
				)
				.take(5);
			const createdEvent =
				events.find(
					(event) => event.eventType === "followUp.created",
				) ?? null;

			if (createdEvent) {
				if (createdEvent.source === "admin") {
					createdSource = "admin";
					createdByUserId =
						createdEvent.actorUserId ?? createdByUserId;
				} else if (createdEvent.source === "closer") {
					createdSource = "closer";
					createdByUserId =
						createdEvent.actorUserId ??
						createdByUserId ??
						followUp.closerId;
				} else if (
					createdEvent.source === "system" &&
					createdEvent.actorUserId === followUp.closerId
				) {
					createdSource = "closer";
					createdByUserId = followUp.closerId;
				} else {
					createdSource = "system";
					createdByUserId = undefined;
					defaulted = true;
				}
			} else {
				createdSource = "system";
				createdByUserId = undefined;
				defaulted = true;
			}

			if (defaulted) {
				defaultedToSystem += 1;
			}

			await ctx.db.patch(followUp._id, {
				createdSource,
				createdByUserId,
			});
			updated += 1;
		}

		if (defaultedToSystem > 0) {
			console.log(
				"[Backfill:FollowUpOrigin] batch complete | updated=%d skipped=%d defaulted=%d",
				updated,
				skipped,
				defaultedToSystem,
			);
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.reporting.backfill.backfillFollowUpOrigin,
				{ cursor: result.continueCursor },
			);
		}

		return {
			hasMore: !result.isDone,
			updated,
			skipped,
			defaultedToSystem,
		};
	},
});

export const auditFollowUpOriginBackfill = internalQuery({
	args: {},
	handler: async (ctx) => {
		let cursor: string | null = null;
		let total = 0;
		let withSource = 0;
		let withCreator = 0;
		const bySource: Record<FollowUpCreatedSource, number> = {
			closer: 0,
			admin: 0,
			system: 0,
		};

		while (true) {
			const result = await ctx.db.query("followUps").paginate({
				numItems: 500,
				cursor,
			});

			for (const followUp of result.page) {
				total += 1;

				if (followUp.createdSource !== undefined) {
					withSource += 1;
					bySource[followUp.createdSource] += 1;
				}
				if (followUp.createdByUserId !== undefined) {
					withCreator += 1;
				}
			}

			if (result.isDone) {
				break;
			}
			cursor = result.continueCursor;
		}

		return {
			total,
			withSource,
			unsetSource: total - withSource,
			withCreator,
			unsetCreator: total - withCreator,
			bySource,
		};
	},
});
