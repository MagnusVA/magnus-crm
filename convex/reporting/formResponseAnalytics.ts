import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange } from "./lib/helpers";

const MAX_FIELD_CATALOG_ROWS = 200;
const MAX_FORM_RESPONSE_ROWS = 2500;
const MAX_FORM_RESPONSE_KPI_MEETING_ROWS = 2000;
const MAX_FORM_RESPONSE_KPI_RESPONSE_ROWS = 5000;

export const getFieldCatalog = query({
	args: {},
	handler: async (ctx) => {
		const { tenantId } = await requireTenantUser(ctx, [
			"tenant_master",
			"tenant_admin",
		]);

		const fields = await ctx.db
			.query("eventTypeFieldCatalog")
			.withIndex("by_tenantId_and_fieldKey", (q) =>
				q.eq("tenantId", tenantId),
			)
			.take(MAX_FIELD_CATALOG_ROWS + 1);
		const catalogRows = fields.slice(0, MAX_FIELD_CATALOG_ROWS);

		const eventTypeConfigIds = [
			...new Set(catalogRows.map((field) => field.eventTypeConfigId)),
		];
		const eventTypeConfigDocs = await Promise.all(
			eventTypeConfigIds.map(
				async (eventTypeConfigId) =>
					[
						eventTypeConfigId,
						await ctx.db.get(eventTypeConfigId),
					] as const,
			),
		);
		const eventTypeConfigById = new Map<
			Id<"eventTypeConfigs">,
			{ displayName?: string } | null
		>(eventTypeConfigDocs);

		return catalogRows
			.map((field) => ({
				id: field._id,
				fieldKey: field.fieldKey,
				currentLabel: field.currentLabel,
				eventTypeConfigId: field.eventTypeConfigId,
				eventTypeName:
					eventTypeConfigById.get(field.eventTypeConfigId)
						?.displayName ?? null,
				firstSeenAt: field.firstSeenAt,
				lastSeenAt: field.lastSeenAt,
				valueType: field.valueType ?? null,
			}))
			.sort((left, right) =>
				left.currentLabel.localeCompare(right.currentLabel),
			);
	},
});

export const getAnswerDistribution = query({
	args: {
		fieldKey: v.string(),
		startDate: v.optional(v.number()),
		endDate: v.optional(v.number()),
	},
	handler: async (ctx, { fieldKey, startDate, endDate }) => {
		const { tenantId } = await requireTenantUser(ctx, [
			"tenant_master",
			"tenant_admin",
		]);

		const normalizedFieldKey = fieldKey.trim();
		if (normalizedFieldKey.length === 0) {
			throw new Error("fieldKey is required");
		}

		if (startDate !== undefined && endDate !== undefined) {
			assertValidDateRange(startDate, endDate);
		} else {
			if (startDate !== undefined && !Number.isFinite(startDate)) {
				throw new Error("startDate must be a finite number");
			}
			if (endDate !== undefined && !Number.isFinite(endDate)) {
				throw new Error("endDate must be a finite number");
			}
		}

		const rows = await ctx.db
			.query("meetingFormResponses")
			.withIndex("by_tenantId_and_fieldKey", (q) =>
				q.eq("tenantId", tenantId).eq("fieldKey", normalizedFieldKey),
			)
			.take(MAX_FORM_RESPONSE_ROWS + 1);

		const filteredRows = rows
			.slice(0, MAX_FORM_RESPONSE_ROWS)
			.filter((row) => {
				if (startDate !== undefined && row.capturedAt < startDate) {
					return false;
				}
				if (endDate !== undefined && row.capturedAt >= endDate) {
					return false;
				}
				return true;
			});

		const counts = new Map<string, number>();
		for (const row of filteredRows) {
			const answer = row.answerText.trim();
			if (answer.length === 0) {
				continue;
			}
			counts.set(answer, (counts.get(answer) ?? 0) + 1);
		}

		const totalResponses = [...counts.values()].reduce(
			(sum, count) => sum + count,
			0,
		);
		const distribution = [...counts.entries()]
			.map(([answer, count]) => ({
				answer,
				count,
				percent:
					totalResponses > 0 ? (count / totalResponses) * 100 : 0,
			}))
			.sort(
				(left, right) =>
					right.count - left.count ||
					left.answer.localeCompare(right.answer),
			);

		return {
			fieldKey: normalizedFieldKey,
			totalResponses,
			distinctAnswers: distribution.length,
			distribution,
			isTruncated: rows.length > MAX_FORM_RESPONSE_ROWS,
		};
	},
});

export const getFormResponseKpis = query({
	args: {
		startDate: v.number(),
		endDate: v.number(),
	},
	handler: async (ctx, { startDate, endDate }) => {
		assertValidDateRange(startDate, endDate);

		const { tenantId } = await requireTenantUser(ctx, [
			"tenant_master",
			"tenant_admin",
		]);

		const meetingRows = await ctx.db
			.query("meetings")
			.withIndex("by_tenantId_and_scheduledAt", (q) =>
				q
					.eq("tenantId", tenantId)
					.gte("scheduledAt", startDate)
					.lt("scheduledAt", endDate),
			)
			.take(MAX_FORM_RESPONSE_KPI_MEETING_ROWS + 1);
		const meetings = meetingRows.slice(
			0,
			MAX_FORM_RESPONSE_KPI_MEETING_ROWS,
		);

		const respondedMeetingIds = new Set<Id<"meetings">>();
		const answersByField = new Map<string, Map<string, number>>();
		let totalFormResponsesRead = 0;
		let isFormResponsesTruncated = false;

		for (const meeting of meetings) {
			for await (const response of ctx.db
				.query("meetingFormResponses")
				.withIndex("by_meetingId", (q) =>
					q.eq("meetingId", meeting._id),
				)) {
				if (
					totalFormResponsesRead >=
					MAX_FORM_RESPONSE_KPI_RESPONSE_ROWS
				) {
					isFormResponsesTruncated = true;
					break;
				}

				totalFormResponsesRead += 1;
				respondedMeetingIds.add(meeting._id);

				const answer = response.answerText.trim();
				if (answer.length === 0) {
					continue;
				}

				const countsForField =
					answersByField.get(response.fieldKey) ??
					new Map<string, number>();
				countsForField.set(
					answer,
					(countsForField.get(answer) ?? 0) + 1,
				);
				answersByField.set(response.fieldKey, countsForField);
			}

			if (isFormResponsesTruncated) {
				break;
			}
		}

		const topAnswerPerField = [...answersByField.entries()]
			.map(([fieldKey, answerCounts]) => {
				const topEntry = [...answerCounts.entries()].sort(
					(left, right) =>
						right[1] - left[1] || left[0].localeCompare(right[0]),
				)[0];
				const totalResponses = [...answerCounts.values()].reduce(
					(sum, count) => sum + count,
					0,
				);

				return {
					fieldKey,
					topAnswer: topEntry?.[0] ?? "",
					topAnswerCount: topEntry?.[1] ?? 0,
					totalResponses,
					topAnswerShare:
						totalResponses > 0 && topEntry
							? topEntry[1] / totalResponses
							: 0,
				};
			})
			.sort((left, right) => left.fieldKey.localeCompare(right.fieldKey));

		return {
			totalMeetings: meetings.length,
			respondedMeetingsCount: respondedMeetingIds.size,
			formResponseRate:
				meetings.length > 0
					? respondedMeetingIds.size / meetings.length
					: null,
			topAnswerPerField,
			isMeetingsTruncated:
				meetingRows.length > MAX_FORM_RESPONSE_KPI_MEETING_ROWS,
			isFormResponsesTruncated,
		};
	},
});
