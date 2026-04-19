import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "../_generated/server";
import { getString, isRecord } from "../lib/payloadExtraction";
import { requireSystemAdminSession } from "../requireSystemAdmin";
import {
	customerConversions,
	leadTimeline,
	meetingsByStatus,
	opportunityByStatus,
	paymentSums,
} from "../reporting/aggregates";

const CLEANUP_BATCH_SIZE = 128;
const RAW_EVENT_SCAN_PAGE_SIZE = 128;
const MAX_PREVIEW_SAMPLES = 5;

const SUPPORTED_REPLAY_EVENT_TYPES = [
	"invitee.created",
	"invitee.canceled",
	"invitee_no_show.created",
	"invitee_no_show.deleted",
] as const;

type SupportedReplayEventType = (typeof SUPPORTED_REPLAY_EVENT_TYPES)[number];

const SUPPORTED_REPLAY_EVENT_TYPE_SET = new Set<string>(
	SUPPORTED_REPLAY_EVENT_TYPES,
);

const EVENT_TYPE_PRIORITY: Record<SupportedReplayEventType, number> = {
	"invitee.created": 0,
	"invitee.canceled": 1,
	"invitee_no_show.created": 2,
	"invitee_no_show.deleted": 3,
};

type RawWebhookScanRow = {
	eventType: string;
	payload: string;
	rawEventId: Id<"rawWebhookEvents">;
	receivedAt: number;
};

type RawWebhookScanPage = {
	continueCursor: string;
	isDone: boolean;
	page: RawWebhookScanRow[];
};

type ReplayCandidate = {
	calendlyEventUri?: string;
	eventOccurredAt: number;
	eventType: SupportedReplayEventType;
	rawEventId: Id<"rawWebhookEvents">;
	receivedAt: number;
	scheduledStartAt?: number;
};

type ReplayPreviewSample = {
	calendlyEventUri: string | null;
	rawEventId: Id<"rawWebhookEvents">;
	scheduledStartIso: string;
};

type ReplayPreview = {
	invalidPayloadsSkipped: number;
	inviteeCreatedIncluded: number;
	inviteeCreatedMissingEventUri: number;
	inviteeCreatedMissingScheduledStart: number;
	inviteeCreatedPreCutoffSkipped: number;
	relatedEventsIncluded: number;
	relatedEventsMissingEventUri: number;
	relatedEventsSkippedWithoutMatchingInviteeCreated: number;
	sampleIncludedScheduledEvents: ReplayPreviewSample[];
	sampleSkippedPreCutoffScheduledEvents: ReplayPreviewSample[];
	scheduledStartCutoffIso: string;
	supportedRawEventsScanned: number;
	totalRawEventsScanned: number;
	totalReplayEvents: number;
	uniqueScheduledEventUrisIncluded: number;
	unsupportedRawEventsSkipped: number;
};

type ReplayPlan = ReplayPreview & {
	candidates: ReplayCandidate[];
};

type ResetBatchResult = {
	deletedCounts: Record<string, number>;
	hasMore: boolean;
};

type AggregateResetResult = {
	clearedNamespaces: string[];
};

type ResolvedFreshStartTenant = {
	activeTenantCount: number;
	companyName: string;
	resolution: "sole_active_tenant" | "sole_tenant";
	status: Doc<"tenants">["status"];
	tenantId: Id<"tenants">;
	totalTenantCount: number;
};

type AdminActionCtx = ActionCtx;

function isSupportedReplayEventType(
	value: string,
): value is SupportedReplayEventType {
	return SUPPORTED_REPLAY_EVENT_TYPE_SET.has(value);
}

function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseUtcCutoffIso(cutoffIso: string): number {
	if (!cutoffIso.endsWith("Z")) {
		throw new Error(
			"scheduledStartCutoffIso must be an explicit UTC timestamp ending in 'Z'",
		);
	}

	const parsed = parseIsoTimestamp(cutoffIso);
	if (parsed === undefined) {
		throw new Error(
			`Invalid scheduledStartCutoffIso: ${cutoffIso}`,
		);
	}

	return parsed;
}

function addPreviewSample(
	samples: ReplayPreviewSample[],
	candidate: ReplayCandidate,
): void {
	if (
		samples.length >= MAX_PREVIEW_SAMPLES ||
		candidate.scheduledStartAt === undefined
	) {
		return;
	}

	samples.push({
		rawEventId: candidate.rawEventId,
		calendlyEventUri: candidate.calendlyEventUri ?? null,
		scheduledStartIso: new Date(candidate.scheduledStartAt).toISOString(),
	});
}

function compareReplayCandidates(
	left: ReplayCandidate,
	right: ReplayCandidate,
): number {
	return (
		left.eventOccurredAt - right.eventOccurredAt ||
		EVENT_TYPE_PRIORITY[left.eventType] - EVENT_TYPE_PRIORITY[right.eventType] ||
		left.receivedAt - right.receivedAt ||
		String(left.rawEventId).localeCompare(String(right.rawEventId))
	);
}

function extractReplayCandidate(
	row: RawWebhookScanRow,
): ReplayCandidate | null {
	let envelope: unknown;
	try {
		envelope = JSON.parse(row.payload);
	} catch {
		return null;
	}

	if (!isRecord(envelope)) {
		return null;
	}

	const payload = isRecord(envelope.payload) ? envelope.payload : null;
	if (!payload || !isSupportedReplayEventType(row.eventType)) {
		return null;
	}

	const scheduledEvent = isRecord(payload.scheduled_event)
		? payload.scheduled_event
		: null;
	const calendlyEventUri =
		(scheduledEvent ? getString(scheduledEvent, "uri") : undefined) ??
		getString(payload, "event");

	return {
		rawEventId: row.rawEventId,
		eventType: row.eventType,
		receivedAt: row.receivedAt,
		eventOccurredAt:
			parseIsoTimestamp(getString(envelope, "created_at")) ??
			parseIsoTimestamp(getString(payload, "created_at")) ??
			row.receivedAt,
		calendlyEventUri,
		scheduledStartAt: scheduledEvent
			? parseIsoTimestamp(getString(scheduledEvent, "start_time"))
			: undefined,
	};
}

async function requireSystemAdmin(ctx: AdminActionCtx): Promise<void> {
	const identity = await ctx.auth.getUserIdentity();
	requireSystemAdminSession(identity);
}

async function listAllTenants(ctx: QueryCtx): Promise<Doc<"tenants">[]> {
	const tenants: Doc<"tenants">[] = [];
	for await (const tenant of ctx.db.query("tenants")) {
		tenants.push(tenant);
	}
	return tenants;
}

async function deleteMeetingCommentsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("meetingComments")
		.withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteMeetingReassignmentsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("meetingReassignments")
		.withIndex("by_tenantId_and_reassignedAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteMeetingReviewsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("meetingReviews")
		.withIndex("by_tenantId_and_status_and_createdAt", (q) =>
			q.eq("tenantId", tenantId),
		)
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteMeetingFormResponsesBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("meetingFormResponses")
		.withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteEventTypeFieldCatalogBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("eventTypeFieldCatalog")
		.withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteFollowUpsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("followUps")
		.withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deletePaymentRecordsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("paymentRecords")
		.withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		if (row.proofFileId) {
			await ctx.storage.delete(row.proofFileId);
		}
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteCustomersBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("customers")
		.withIndex("by_tenantId_and_convertedAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteDomainEventsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("domainEvents")
		.withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteMeetingsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("meetings")
		.withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteOpportunitiesBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("opportunities")
		.withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteLeadIdentifiersBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("leadIdentifiers")
		.withIndex("by_tenantId_and_value", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteLeadMergeHistoryBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("leadMergeHistory")
		.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteLeadsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("leads")
		.withIndex("by_tenantId_and_firstSeenAt", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function deleteTenantStatsBatch(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
): Promise<number> {
	const rows = await ctx.db
		.query("tenantStats")
		.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
		.take(CLEANUP_BATCH_SIZE);

	for (const row of rows) {
		await ctx.db.delete(row._id);
	}

	return rows.length;
}

async function buildReplayPlan(
	ctx: AdminActionCtx,
	args: {
		scheduledStartCutoffMs: number;
		tenantId: Id<"tenants">;
	},
): Promise<ReplayPlan> {
	let cursor: string | null = null;
	const candidates: ReplayCandidate[] = [];
	const relatedCandidates: ReplayCandidate[] = [];
	const allowedEventUris = new Set<string>();

	const preview: ReplayPreview = {
		totalRawEventsScanned: 0,
		supportedRawEventsScanned: 0,
		unsupportedRawEventsSkipped: 0,
		invalidPayloadsSkipped: 0,
		inviteeCreatedIncluded: 0,
		inviteeCreatedPreCutoffSkipped: 0,
		inviteeCreatedMissingScheduledStart: 0,
		inviteeCreatedMissingEventUri: 0,
		relatedEventsIncluded: 0,
		relatedEventsSkippedWithoutMatchingInviteeCreated: 0,
		relatedEventsMissingEventUri: 0,
		totalReplayEvents: 0,
		uniqueScheduledEventUrisIncluded: 0,
		scheduledStartCutoffIso: new Date(args.scheduledStartCutoffMs).toISOString(),
		sampleIncludedScheduledEvents: [],
		sampleSkippedPreCutoffScheduledEvents: [],
	};

	while (true) {
		const page: RawWebhookScanPage = await ctx.runQuery(
			internal.admin.rawWebhookReplay.listRawWebhookEventsPageByReceivedAt,
			{
				tenantId: args.tenantId,
				paginationOpts: {
					cursor,
					numItems: RAW_EVENT_SCAN_PAGE_SIZE,
				},
			},
		);

		for (const row of page.page) {
			preview.totalRawEventsScanned += 1;

			if (!isSupportedReplayEventType(row.eventType)) {
				preview.unsupportedRawEventsSkipped += 1;
				continue;
			}

			preview.supportedRawEventsScanned += 1;
			const candidate = extractReplayCandidate(row);
			if (!candidate) {
				preview.invalidPayloadsSkipped += 1;
				continue;
			}

			if (candidate.eventType === "invitee.created") {
				if (candidate.scheduledStartAt === undefined) {
					preview.inviteeCreatedMissingScheduledStart += 1;
					continue;
				}

				if (!candidate.calendlyEventUri) {
					preview.inviteeCreatedMissingEventUri += 1;
					continue;
				}

				if (candidate.scheduledStartAt < args.scheduledStartCutoffMs) {
					preview.inviteeCreatedPreCutoffSkipped += 1;
					addPreviewSample(
						preview.sampleSkippedPreCutoffScheduledEvents,
						candidate,
					);
					continue;
				}

				preview.inviteeCreatedIncluded += 1;
				addPreviewSample(preview.sampleIncludedScheduledEvents, candidate);
				allowedEventUris.add(candidate.calendlyEventUri);
				candidates.push(candidate);
				continue;
			}

			relatedCandidates.push(candidate);
		}

		if (page.isDone) {
			break;
		}

		cursor = page.continueCursor;
	}

	for (const candidate of relatedCandidates) {
		if (!candidate.calendlyEventUri) {
			preview.relatedEventsMissingEventUri += 1;
			continue;
		}

		if (!allowedEventUris.has(candidate.calendlyEventUri)) {
			preview.relatedEventsSkippedWithoutMatchingInviteeCreated += 1;
			continue;
		}

		preview.relatedEventsIncluded += 1;
		candidates.push(candidate);
	}

	candidates.sort(compareReplayCandidates);

	preview.totalReplayEvents = candidates.length;
	preview.uniqueScheduledEventUrisIncluded = allowedEventUris.size;

	return {
		...preview,
		candidates,
	};
}

export const listRawWebhookEventsPageByReceivedAt = internalQuery({
	args: {
		paginationOpts: paginationOptsValidator,
		tenantId: v.id("tenants"),
	},
	handler: async (ctx, { paginationOpts, tenantId }): Promise<RawWebhookScanPage> => {
		const result = await ctx.db
			.query("rawWebhookEvents")
			.withIndex("by_tenantId_and_receivedAt", (q) => q.eq("tenantId", tenantId))
			.paginate(paginationOpts);

		return {
			page: result.page.map((rawEvent) => ({
				rawEventId: rawEvent._id,
				eventType: rawEvent.eventType,
				payload: rawEvent.payload,
				receivedAt: rawEvent.receivedAt,
			})),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const resolveFreshStartTenant = internalQuery({
	args: {},
	handler: async (ctx): Promise<ResolvedFreshStartTenant> => {
		const activeTenants = await ctx.db
			.query("tenants")
			.withIndex("by_status", (q) => q.eq("status", "active"))
			.take(10);
		const allTenants = await listAllTenants(ctx);

		if (activeTenants.length === 1) {
			return {
				tenantId: activeTenants[0]._id,
				companyName: activeTenants[0].companyName,
				status: activeTenants[0].status,
				resolution: "sole_active_tenant",
				activeTenantCount: activeTenants.length,
				totalTenantCount: allTenants.length,
			};
		}

		if (activeTenants.length === 0 && allTenants.length === 1) {
			return {
				tenantId: allTenants[0]._id,
				companyName: allTenants[0].companyName,
				status: allTenants[0].status,
				resolution: "sole_tenant",
				activeTenantCount: activeTenants.length,
				totalTenantCount: allTenants.length,
			};
		}

		throw new Error(
			`Fresh-start replay expects exactly one target tenant. Found activeTenantCount=${activeTenants.length} totalTenantCount=${allTenants.length}.`,
		);
	},
});

export const deleteFreshStartOperationalDataBatch = internalMutation({
	args: {
		tenantId: v.id("tenants"),
	},
	handler: async (ctx, { tenantId }): Promise<ResetBatchResult> => {
		const deletedCounts: Record<string, number> = {};

		deletedCounts.meetingComments = await deleteMeetingCommentsBatch(ctx, tenantId);
		deletedCounts.meetingReassignments = await deleteMeetingReassignmentsBatch(
			ctx,
			tenantId,
		);
		deletedCounts.meetingReviews = await deleteMeetingReviewsBatch(ctx, tenantId);
		deletedCounts.meetingFormResponses = await deleteMeetingFormResponsesBatch(
			ctx,
			tenantId,
		);
		deletedCounts.eventTypeFieldCatalog = await deleteEventTypeFieldCatalogBatch(
			ctx,
			tenantId,
		);
		deletedCounts.followUps = await deleteFollowUpsBatch(ctx, tenantId);
		deletedCounts.paymentRecords = await deletePaymentRecordsBatch(ctx, tenantId);
		deletedCounts.customers = await deleteCustomersBatch(ctx, tenantId);
		deletedCounts.domainEvents = await deleteDomainEventsBatch(ctx, tenantId);
		deletedCounts.meetings = await deleteMeetingsBatch(ctx, tenantId);
		deletedCounts.opportunities = await deleteOpportunitiesBatch(ctx, tenantId);
		deletedCounts.leadIdentifiers = await deleteLeadIdentifiersBatch(ctx, tenantId);
		deletedCounts.leadMergeHistory = await deleteLeadMergeHistoryBatch(
			ctx,
			tenantId,
		);
		deletedCounts.leads = await deleteLeadsBatch(ctx, tenantId);
		deletedCounts.tenantStats = await deleteTenantStatsBatch(ctx, tenantId);

		const hasMore = Object.values(deletedCounts).some(
			(count) => count === CLEANUP_BATCH_SIZE,
		);

		return {
			deletedCounts,
			hasMore,
		};
	},
});

export const setRawWebhookProcessedState = internalMutation({
	args: {
		processed: v.boolean(),
		rawEventId: v.id("rawWebhookEvents"),
	},
	handler: async (ctx, { rawEventId, processed }) => {
		const rawEvent = await ctx.db.get(rawEventId);
		if (!rawEvent) {
			throw new Error(`Raw webhook event not found: ${rawEventId}`);
		}

		await ctx.db.patch(rawEventId, { processed });
	},
});

export const clearReportingAggregatesForTenant = internalMutation({
	args: {
		tenantId: v.id("tenants"),
	},
	handler: async (ctx, { tenantId }): Promise<AggregateResetResult> => {
		await meetingsByStatus.clear(ctx, { namespace: tenantId });
		await paymentSums.clear(ctx, { namespace: tenantId });
		await opportunityByStatus.clear(ctx, { namespace: tenantId });
		await leadTimeline.clear(ctx, { namespace: tenantId });
		await customerConversions.clear(ctx, { namespace: tenantId });

		return {
			clearedNamespaces: [
				"meetingsByStatus",
				"paymentSums",
				"opportunityByStatus",
				"leadTimeline",
				"customerConversions",
			],
		};
	},
});

export const previewFreshStartFromRawWebhooks = action({
	args: {
		scheduledStartCutoffIso: v.string(),
	},
	handler: async (ctx, { scheduledStartCutoffIso }) => {
		await requireSystemAdmin(ctx);
		const targetTenant: ResolvedFreshStartTenant = await ctx.runQuery(
			internal.admin.rawWebhookReplay.resolveFreshStartTenant,
			{},
		);
		const scheduledStartCutoffMs = parseUtcCutoffIso(
			scheduledStartCutoffIso,
		);
		const plan = await buildReplayPlan(ctx, {
			tenantId: targetTenant.tenantId,
			scheduledStartCutoffMs,
		});

		const { candidates: _candidates, ...preview } = plan;
		return {
			targetTenant,
			...preview,
		};
	},
});

export const rebuildFreshStartFromRawWebhooks = action({
	args: {
		confirmDestructiveReset: v.boolean(),
		scheduledStartCutoffIso: v.string(),
	},
	handler: async (ctx, { scheduledStartCutoffIso, confirmDestructiveReset }) => {
		await requireSystemAdmin(ctx);
		const targetTenant: ResolvedFreshStartTenant = await ctx.runQuery(
			internal.admin.rawWebhookReplay.resolveFreshStartTenant,
			{},
		);
		const tenantId = targetTenant.tenantId;
		console.log("[Admin:RawWebhookReplay] Rebuild requested", {
			tenantId,
			targetTenant,
			scheduledStartCutoffIso,
		});

		if (!confirmDestructiveReset) {
			throw new Error(
				"confirmDestructiveReset must be true before deleting operational data",
			);
		}

		const scheduledStartCutoffMs = parseUtcCutoffIso(
			scheduledStartCutoffIso,
		);
		const plan = await buildReplayPlan(ctx, {
			tenantId,
			scheduledStartCutoffMs,
		});
		const { candidates, ...preview } = plan;

		if (preview.inviteeCreatedIncluded === 0 || preview.totalReplayEvents === 0) {
			throw new Error(
				`Refusing destructive reset: no replayable invitee.created events found on or after ${preview.scheduledStartCutoffIso}`,
			);
		}

		const aggregateReset: AggregateResetResult = await ctx.runMutation(
			internal.admin.rawWebhookReplay.clearReportingAggregatesForTenant,
			{ tenantId },
		);

		const deletedCounts: Record<string, number> = {};
		while (true) {
			const batch: ResetBatchResult = await ctx.runMutation(
				internal.admin.rawWebhookReplay.deleteFreshStartOperationalDataBatch,
				{ tenantId },
			);

			for (const [table, count] of Object.entries(batch.deletedCounts)) {
				deletedCounts[table] = (deletedCounts[table] ?? 0) + count;
			}

			if (!batch.hasMore) {
				break;
			}
		}

		let replayedInviteeCreated = 0;
		let replayedRelatedEvents = 0;

		for (const candidate of candidates) {
			await ctx.runMutation(
				internal.admin.rawWebhookReplay.setRawWebhookProcessedState,
				{
					rawEventId: candidate.rawEventId,
					processed: false,
				},
			);

			try {
				await ctx.runAction(internal.pipeline.processor.processRawEvent, {
					rawEventId: candidate.rawEventId,
				});
			} catch (error) {
				throw new Error(
					`Replay failed for rawEventId=${candidate.rawEventId} eventType=${candidate.eventType} calendlyEventUri=${candidate.calendlyEventUri ?? "unknown"}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}

			if (candidate.eventType === "invitee.created") {
				replayedInviteeCreated += 1;
			} else {
				replayedRelatedEvents += 1;
			}
		}

		await ctx.runMutation(internal.admin.migrations.seedTenantStatsInternal, {
			tenantId,
		});

		console.log("[Admin:RawWebhookReplay] Rebuild completed", {
			tenantId,
			scheduledStartCutoffIso: preview.scheduledStartCutoffIso,
			clearedAggregates: aggregateReset.clearedNamespaces,
			deletedCounts,
			replayedInviteeCreated,
			replayedRelatedEvents,
		});

		return {
			targetTenant,
			...preview,
			clearedAggregates: aggregateReset.clearedNamespaces,
			deletedCounts,
			replayedInviteeCreated,
			replayedRelatedEvents,
			totalReplayEventsApplied: replayedInviteeCreated + replayedRelatedEvents,
		};
	},
});
