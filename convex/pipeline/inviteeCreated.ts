import { recordMeeting } from "../lib/leadLifecycle";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { blockBooking, ignoreBooking } from "./blocked";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";
import {
	patchOpportunityLifecycle,
	transitionOpportunity,
} from "../lib/opportunityActivity";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { validateTransition } from "../lib/statusTransitions";
import { extractUtmParams } from "../lib/utmParams";
import { clampUtmValue } from "../lib/attribution/normalize";
import {
	recordBookingAttribution,
	recordDealCreation,
} from "../lib/attribution/dealAttributions";
import {
	isInternalUtm,
	resolutionPatch,
	resolveAttributionForTenant,
	type ResolvedAttribution,
} from "../lib/attribution/resolveAttribution";
import { extractMeetingLocation } from "../lib/meetingLocation";
import {
	extractQuestionsAndAnswers,
	toQuestionAnswerRecord,
	writeMeetingFormResponses,
} from "../lib/meetingFormResponses";
import { emitDomainEvent } from "../lib/domainEvents";
import { preserveQualificationAuditMatchForScheduledMeeting } from "../leadGen/auditMatching";
import { isRecord, getString } from "../lib/payloadExtraction";
import {
	isPlaceholderEmail,
	normalizeEmail,
	normalizeSocialHandle,
	normalizePhone,
} from "../lib/normalization";
import type { IdentifierType, SocialPlatformType } from "../lib/normalization";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncOpportunityMeetingsAssignedCloser } from "../lib/syncOpportunityMeetingsAssignedCloser";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
import {
	resolveLeadIdentity,
	resolveExistingLeadIdentity,
} from "../leads/identityResolution";
import {
	insertMeetingAggregate,
	insertOpportunityAggregate,
} from "../reporting/writeHooks";
import {
	findOpenSlackQualifiedOpportunity,
	wasStaleExpiredAfter,
} from "./slackJoinLookup";
import { log, reportError } from "../lib/observability/log";
import { MAX_CHANGED_DEALS, wasUnattachableAt } from "./bookingHistory";
import {
	bookingHostOutcome,
	extractHostMembership,
	isProgramEventType,
	resolveAssignedCloser,
	type AssignedCloserResolution,
	type BookingHostOutcome,
} from "./bookingHost";

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function mergeCustomFields(
	existing: Doc<"leads">["customFields"],
	incoming: Record<string, string> | undefined,
) {
	if (!incoming) {
		return existing;
	}

	if (isRecord(existing)) {
		return { ...existing, ...incoming };
	}

	return incoming;
}

async function syncMeetingFormResponsesForBooking(
	ctx: MutationCtx,
	args: {
		capturedAt: number;
		eventTypeConfigId: Id<"eventTypeConfigs"> | undefined;
		leadId: Id<"leads">;
		meetingId: Id<"meetings">;
		opportunityId: Id<"opportunities">;
		questionsAndAnswers: ReturnType<typeof extractQuestionsAndAnswers>;
		tenantId: Id<"tenants">;
	},
): Promise<void> {
	if (args.questionsAndAnswers.length === 0) {
		return;
	}

	await writeMeetingFormResponses(ctx, args);
}

async function getCallClassificationForOpportunity(
	ctx: MutationCtx,
	opportunityId: Id<"opportunities">,
): Promise<"new" | "follow_up"> {
	const existingMeeting = await ctx.db
		.query("meetings")
		.withIndex("by_opportunityId_and_scheduledAt", (q) =>
			q.eq("opportunityId", opportunityId),
		)
		.first();

	return existingMeeting ? "follow_up" : "new";
}

function bookedProgramPatch(config: Doc<"eventTypeConfigs"> | null | undefined) {
	return {
		bookingProgramId: config?.bookingProgramId,
		bookingProgramName: config?.bookingProgramName,
		bookingProgramMappingStatus:
			config?.bookingProgramMappingStatus ?? ("unmapped" as const),
	};
}

async function loadEventTypeConfig(
	ctx: MutationCtx,
	eventTypeConfigId: Id<"eventTypeConfigs"> | undefined,
) {
	return eventTypeConfigId ? await ctx.db.get("eventTypeConfigs", eventTypeConfigId) : null;
}

/**
 * The deal's caches of its first external booking. Attribution isn't one of
 * them: the deal's credit is its first booking's `dealAttributions` rows, and
 * the resolution stays on the meeting (docs/plans/phase-3-attribution.md §3.3).
 */
async function patchFirstExternalBookingCaches(
	ctx: MutationCtx,
	args: {
		opportunity: Doc<"opportunities">;
		meetingId: Id<"meetings">;
		scheduledAt: number;
		eventTypeConfig: Doc<"eventTypeConfigs"> | null | undefined;
		utmParams: ReturnType<typeof extractUtmParams>;
	},
) {
	if (isInternalUtm(args.utmParams) || args.opportunity.firstMeetingId) {
		return;
	}

	const bookingProgram = bookedProgramPatch(args.eventTypeConfig);
	const utmPatch = args.utmParams ? { utmParams: args.utmParams } : {};
	await ctx.db.patch("opportunities", args.opportunity._id, {
		firstBookingProgramId: bookingProgram.bookingProgramId,
		firstBookingProgramName: bookingProgram.bookingProgramName,
		firstBookingProgramMappingStatus:
			bookingProgram.bookingProgramMappingStatus,
		firstBookedAt: args.scheduledAt,
		firstMeetingId: args.meetingId,
		firstMeetingAt: args.scheduledAt,
		...utmPatch,
	});
}

/**
 * The booking's attribution rows (docs/plans/phase-3-attribution.md §4.1),
 * written right after each meeting insert.
 */
async function recordMeetingBookingAttribution(
	ctx: MutationCtx,
	meetingId: Id<"meetings">,
	resolvedAttribution: ResolvedAttribution,
) {
	const meeting = await ctx.db.get("meetings", meetingId);
	if (!meeting) {
		throw new Error("[Pipeline] Meeting disappeared after insert");
	}
	await recordBookingAttribution(ctx, {
		meeting,
		credit: {
			teamId: resolvedAttribution.teamId,
			dmCloserId: resolvedAttribution.dmCloserId,
		},
	});
}

// ---------------------------------------------------------------------------
// Feature E: Types
// ---------------------------------------------------------------------------

/**
 * Result of extracting identifiers from custom form fields.
 */
type ExtractedIdentifiers = {
	socialHandle?: {
		rawValue: string;
		platform: SocialPlatformType;
	};
	phoneOverride?: string;
};

type EventTypeConfigLookupResult = {
	existingConfig: Doc<"eventTypeConfigs"> | null;
	candidateCount: number;
};

type LeadIdentifierUpsertResult =
	| "created"
	| "existing_same_lead"
	| "existing_other_lead";

// ---------------------------------------------------------------------------
// Feature B4: Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age of a no-show/canceled opportunity for heuristic relinking.
 * Older opportunities are treated as unrelated bookings.
 */
const RESCHEDULE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Feature E: Helper Functions (3A)
// ---------------------------------------------------------------------------

/**
 * Extract social handle and phone override from custom form fields
 * using the event type's customFieldMappings configuration (Feature F).
 */
function extractIdentifiersFromCustomFields(
	customFields: Record<string, string> | undefined,
	config: Doc<"eventTypeConfigs"> | null,
): ExtractedIdentifiers {
	const result: ExtractedIdentifiers = {};

	if (!customFields || !config?.customFieldMappings) {
		return result;
	}

	const mappings = config.customFieldMappings;

	// Social handle extraction
	if (mappings.socialHandleField && mappings.socialHandleType) {
		const rawValue = customFields[mappings.socialHandleField];
		if (rawValue && rawValue.trim().length > 0) {
			result.socialHandle = {
				rawValue: rawValue.trim(),
				platform: mappings.socialHandleType,
			};
		}
	}

	// Phone override extraction
	if (mappings.phoneField) {
		const rawValue = customFields[mappings.phoneField];
		if (rawValue && rawValue.trim().length > 0) {
			result.phoneOverride = rawValue.trim();
		}
	}

	return result;
}

/**
 * Insert a leadIdentifier record if one with the same (tenantId, type, value)
 * does not already exist. Idempotent for webhook retries.
 */
async function upsertLeadIdentifier(
	ctx: MutationCtx,
	record: {
		tenantId: Id<"tenants">;
		leadId: Id<"leads">;
		type: IdentifierType;
		value: string;
		rawValue: string;
		source: "calendly_booking" | "manual_entry" | "merge";
		sourceMeetingId?: Id<"meetings">;
		confidence: "verified" | "inferred" | "suggested";
		createdAt: number;
	},
): Promise<LeadIdentifierUpsertResult> {
	const existing = await ctx.db
		.query("leadIdentifiers")
		.withIndex("by_tenantId_and_type_and_value", (q) =>
			q
				.eq("tenantId", record.tenantId)
				.eq("type", record.type)
				.eq("value", record.value),
		)
		.first();

	if (existing) {
		if (existing.leadId !== record.leadId) {
			log.warn("pipeline.lead_identifier.conflict", {
				tenantId: record.tenantId,
				identifierType: record.type,
				leadId: record.leadId,
				existingLeadId: existing.leadId,
			});
			return "existing_other_lead";
		}
		return "existing_same_lead";
	}

	await ctx.db.insert("leadIdentifiers", record);
	return "created";
}

/**
 * Update the denormalized socialHandles array on the lead.
 */
async function updateLeadSocialHandles(
	ctx: MutationCtx,
	leadId: Id<"leads">,
	platform: SocialPlatformType,
	normalizedHandle: string,
): Promise<void> {
	const lead = await ctx.db.get("leads", leadId);
	if (!lead) {
		return;
	}

	const existing = lead.socialHandles ?? [];
	const alreadyExists = existing.some(
		(handle) =>
			handle.type === platform && handle.handle === normalizedHandle,
	);
	if (alreadyExists) {
		return;
	}

	await ctx.db.patch("leads", leadId, {
		socialHandles: [
			...existing,
			{ type: platform, handle: normalizedHandle },
		],
	});
}

async function syncLeadFromBooking(
	ctx: MutationCtx,
	lead: Doc<"leads">,
	{
		inviteeEmail,
		inviteeName,
		inviteePhone,
		latestCustomFields,
		now,
	}: {
		inviteeEmail: string | undefined;
		inviteeName: string | undefined;
		inviteePhone: string | undefined;
		latestCustomFields: Record<string, string> | undefined;
		now: number;
	},
): Promise<Doc<"leads">> {
	// A placeholder email stays on the booking and never becomes the lead's.
	const bookingEmail =
		inviteeEmail && !isPlaceholderEmail(inviteeEmail) ? inviteeEmail : undefined;
	const updatedLead: Doc<"leads"> = {
		...lead,
		email: lead.email ?? bookingEmail,
		fullName: lead.fullName || inviteeName,
		phone: lead.phone || inviteePhone,
		customFields: mergeCustomFields(lead.customFields, latestCustomFields),
		updatedAt: now,
	};

	await ctx.db.patch("leads", lead._id, {
		email: updatedLead.email,
		fullName: updatedLead.fullName,
		phone: updatedLead.phone,
		customFields: updatedLead.customFields,
		updatedAt: now,
	});
	await syncCustomerSnapshot(ctx, lead.tenantId, lead._id);

	return updatedLead;
}

/**
 * Create leadIdentifier records for all identifiers found in this booking.
 * Called after meeting creation so we have a meetingId for provenance tracking.
 */
async function createLeadIdentifiers(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	leadId: Id<"leads">,
	meetingId: Id<"meetings">,
	normalizedEmail: string,
	rawEmail: string,
	phone: string | undefined,
	socialHandle:
		| { rawValue: string; platform: SocialPlatformType }
		| undefined,
	now: number,
): Promise<void> {
	// Prepare all identifier operations (will run in parallel)
	const identifierOperations: Promise<LeadIdentifierUpsertResult>[] = [];

	// Email identifier ("verified" confidence). A placeholder email is never
	// an identity key.
	if (normalizedEmail && !isPlaceholderEmail(normalizedEmail)) {
		identifierOperations.push(
			upsertLeadIdentifier(ctx, {
				tenantId,
				leadId,
				type: "email",
				value: normalizedEmail,
				rawValue: rawEmail,
				source: "calendly_booking",
				sourceMeetingId: meetingId,
				confidence: "verified",
				createdAt: now,
			}),
		);
	}

	// Phone identifier ("verified" from Calendly or custom field)
	if (phone) {
		const normalizedPhone = normalizePhone(phone);
		if (normalizedPhone) {
			identifierOperations.push(
				upsertLeadIdentifier(ctx, {
					tenantId,
					leadId,
					type: "phone",
					value: normalizedPhone,
					rawValue: phone,
					source: "calendly_booking",
					sourceMeetingId: meetingId,
					confidence: "verified",
					createdAt: now,
				}),
			);
		}
	}

	// Social handle identifier ("inferred" because it comes from a form field mapping)
	let normalizedHandle: string | undefined;
	let socialHandleUpsertResult: LeadIdentifierUpsertResult | undefined;
	if (socialHandle) {
		normalizedHandle = normalizeSocialHandle(
			socialHandle.rawValue,
			socialHandle.platform,
		);
		if (normalizedHandle) {
			socialHandleUpsertResult = await upsertLeadIdentifier(ctx, {
				tenantId,
				leadId,
				type: socialHandle.platform,
				value: normalizedHandle,
				rawValue: socialHandle.rawValue,
				source: "calendly_booking",
				sourceMeetingId: meetingId,
				confidence: "inferred",
				createdAt: now,
			});
		}
	}

	// Execute the remaining identifier upserts in parallel.
	await Promise.all(identifierOperations);

	// Update denormalized socialHandles on the lead (must happen after upsert succeeds)
	if (
		socialHandle &&
		normalizedHandle &&
		socialHandleUpsertResult !== "existing_other_lead"
	) {
		await updateLeadSocialHandles(
			ctx,
			leadId,
			socialHandle.platform,
			normalizedHandle,
		);
	}
}

async function updateLeadSearchText(
	ctx: MutationCtx,
	leadId: Id<"leads">,
): Promise<void> {
	const lead = await ctx.db.get("leads", leadId);
	if (!lead) {
		return;
	}

	const identifiers = await ctx.db
		.query("leadIdentifiers")
		.withIndex("by_leadId", (q) => q.eq("leadId", leadId))
		.take(50);

	const searchText = buildLeadSearchText(
		lead,
		identifiers.map((identifier) => identifier.value),
	);
	if (searchText !== lead.searchText) {
		await ctx.db.patch("leads", leadId, { searchText });
		await refreshOpportunitySearchForLead(ctx, lead.tenantId, leadId);
		return;
	}
	await rebuildLeadCustomerSearchRow(ctx, lead.tenantId, leadId);
}

async function lookupEventTypeConfig(
	ctx: MutationCtx,
	{
		tenantId,
		eventTypeUri,
	}: {
		tenantId: Id<"tenants">;
		eventTypeUri: string | undefined;
	},
): Promise<EventTypeConfigLookupResult> {
	if (!eventTypeUri) {
		return {
			existingConfig: null,
			candidateCount: 0,
		};
	}

	const configCandidates = await ctx.db
		.query("eventTypeConfigs")
		.withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
		)
		.take(8);

	return {
		existingConfig:
			configCandidates.length === 0
				? null
				: configCandidates.reduce((best, row) =>
						row.createdAt < best.createdAt ? row : best,
					),
		candidateCount: configCandidates.length,
	};
}

/**
 * Records an invitee.created dropped because its host isn't a closer: a host
 * known to be a non-closer CRM user, or a host the CRM can't place on an event
 * type not mapped to a program. Both are routine, so they're logged, not
 * reported. `outcome` says which.
 */
function logNonCloserHostSkip(
	attrs: {
		reason:
			| "non_closer_host_without_opportunity"
			| "non_closer_host_untracked_reschedule";
		outcome: BookingHostOutcome & { status: "ignored" };
		tenantId: Id<"tenants">;
		rawEventId: Id<"rawWebhookEvents">;
		closerResolution: AssignedCloserResolution["resolution"];
	} & Record<string, unknown>,
) {
	const { outcome, ...rest } = attrs;
	log.info("pipeline.invitee_created.skipped", {
		...rest,
		outcome: outcome.reason,
	});
}

async function resolveEventTypeConfigId(
	ctx: MutationCtx,
	{
		tenantId,
		eventTypeUri,
		scheduledEvent,
		latestCustomFields,
		now,
		preloadedConfig,
	}: {
		tenantId: Id<"tenants">;
		eventTypeUri: string | undefined;
		scheduledEvent: Record<string, unknown>;
		latestCustomFields: Record<string, string> | undefined;
		now: number;
		preloadedConfig?: Doc<"eventTypeConfigs"> | null;
	},
): Promise<Id<"eventTypeConfigs"> | undefined> {
	if (!eventTypeUri) {
		return undefined;
	}

	// Reuse preloaded config from early lookup if available, avoiding a
	// duplicate query. The early lookup reports duplicate configs.
	const existingConfig =
		preloadedConfig !== undefined
			? preloadedConfig
			: (await lookupEventTypeConfig(ctx, { tenantId, eventTypeUri }))
					.existingConfig;

	if (existingConfig) {
		return existingConfig._id;
	}

	const eventDisplayName =
		getString(scheduledEvent, "name") ?? "Calendly Meeting";
	const initialKeys = latestCustomFields
		? Object.keys(latestCustomFields)
		: undefined;

	const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
		tenantId,
		calendlyEventTypeUri: eventTypeUri,
		displayName: eventDisplayName,
		displayNameSource: "webhook_discovered",
		bookingProgramMappingStatus: "unmapped",
		createdAt: now,
		updatedAt: now,
		knownCustomFieldKeys:
			initialKeys && initialKeys.length > 0 ? initialKeys : undefined,
	});
	log.info("pipeline.event_type_config.auto_created", {
		tenantId,
		eventTypeConfigId,
		initialCustomFieldKeyCount: initialKeys?.length ?? 0,
	});

	return eventTypeConfigId;
}

async function syncKnownCustomFieldKeys(
	ctx: MutationCtx,
	eventTypeConfigId: Id<"eventTypeConfigs"> | undefined,
	latestCustomFields: Record<string, string> | undefined,
) {
	if (!latestCustomFields || !eventTypeConfigId) {
		return;
	}

	const incomingKeys = Object.keys(latestCustomFields).filter(key => !/^q_[a-f0-9]{64}$/.test(key));
	if (incomingKeys.length === 0) {
		return;
	}

	const config = await ctx.db.get("eventTypeConfigs", eventTypeConfigId);
	if (!config) {
		return;
	}

	const existingKeys = config.knownCustomFieldKeys ?? [];
	const existingSet = new Set(existingKeys);
	const newKeys = incomingKeys.filter((key) => !existingSet.has(key));
	if (newKeys.length === 0) {
		return;
	}

	const updatedKeys = [...existingKeys, ...newKeys];
	await ctx.db.patch("eventTypeConfigs", eventTypeConfigId, {
		knownCustomFieldKeys: updatedKeys,
	});
	log.info("pipeline.event_type_config.custom_fields_discovered", {
		tenantId: config.tenantId,
		eventTypeConfigId,
		newKeyCount: newKeys.length,
		totalKeyCount: updatedKeys.length,
	});
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
			log.info("pipeline.invitee_created.skipped", {
				reason: rawEvent ? "already_processed" : "raw_event_missing",
				tenantId,
				rawEventId,
			});
			return;
		}

		if (rawEvent.tenantId !== tenantId) throw new Error("Webhook tenant mismatch");

		if (!isRecord(payload) || !isRecord(payload.scheduled_event)) {
			throw new Error("[Pipeline] Invalid invitee.created payload");
		}

		const rawInviteeEmail = getString(payload, "email");
		const inviteeEmail = rawInviteeEmail
			? normalizeEmail(rawInviteeEmail)
			: undefined;
		const inviteeName = getString(payload, "name");
		const inviteePhone = getString(payload, "text_reminder_number");
		const calendlyInviteeUri = getString(payload, "uri");
		const scheduledEvent = payload.scheduled_event;
		const calendlyEventUri = getString(scheduledEvent, "uri");
		const eventTypeUri = getString(scheduledEvent, "event_type");
		const scheduledAt = parseTimestamp(scheduledEvent.start_time);
		const endTime = parseTimestamp(scheduledEvent.end_time);


		if (
			!inviteeEmail ||
			!rawInviteeEmail ||
			!calendlyInviteeUri ||
			!calendlyEventUri ||
			scheduledAt === undefined ||
			endTime === undefined
		) {
			log.warn("pipeline.invitee_created.rejected", {
				reason: "missing_required_fields",
				tenantId,
				rawEventId,
				hasEmail: !!inviteeEmail,
				hasInviteeUri: !!calendlyInviteeUri,
				hasEventUri: !!calendlyEventUri,
				hasStartTime: scheduledAt !== undefined,
				hasEndTime: endTime !== undefined,
			});
			throw new Error(
				"[Pipeline] Missing required fields in invitee.created payload",
			);
		}

		const existingMeeting = await ctx.db
			.query("meetings")
			.withIndex("by_tenantId_and_calendlyEventUri", (q) =>
				q
					.eq("tenantId", tenantId)
					.eq("calendlyEventUri", calendlyEventUri),
			)
			.unique();
		if (existingMeeting) {
			log.info("pipeline.invitee_created.skipped", {
				reason: "duplicate_meeting",
				tenantId,
				rawEventId,
				meetingId: existingMeeting._id,
				opportunityId: existingMeeting.opportunityId,
			});
			await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
			return;
		}

		const now = rawEvent.occurredAt ?? rawEvent.receivedAt;
		const durationMinutes = Math.max(
			1,
			Math.round((endTime - scheduledAt) / 60000),
		);
		const bookingQuestionsAndAnswers = extractQuestionsAndAnswers(
			payload.questions_and_answers,
		);
		const latestCustomFields = await toQuestionAnswerRecord(
			bookingQuestionsAndAnswers,
		);
		const rawUtmParams = extractUtmParams(payload.tracking);
		const clampedSource = clampUtmValue(rawUtmParams?.utm_source);
		const clampedMedium = clampUtmValue(rawUtmParams?.utm_medium);
		const utmParams = rawUtmParams
			? {
					...rawUtmParams,
					utm_source: clampedSource.value,
					utm_medium: clampedMedium.value,
				}
			: undefined;
		const utmTruncated = clampedSource.truncated || clampedMedium.truncated;
		const resolvedAttribution = await resolveAttributionForTenant(ctx, {
			tenantId,
			utmParams,
		});
		const eventTypeConfigLookup = await lookupEventTypeConfig(ctx, {
			tenantId,
			eventTypeUri,
		});
		const earlyEventTypeConfig = eventTypeConfigLookup.existingConfig;
		if (eventTypeConfigLookup.candidateCount > 1 && earlyEventTypeConfig) {
			// The oldest config wins, so the booking still proceeds.
			reportError(
				"pipeline.data_inconsistency",
				new Error("Multiple event type configs share one Calendly event type"),
				{
					severity: "warning",
					fingerprint: "pipeline.data_inconsistency:duplicate_event_type_configs",
					reason: "duplicate_event_type_configs",
					tenantId,
					rawEventId,
					eventTypeConfigId: earlyEventTypeConfig._id,
					candidateCount: eventTypeConfigLookup.candidateCount,
				},
			);
		}
		const extractedIdentifiers = extractIdentifiersFromCustomFields(
			{ ...latestCustomFields, ...Object.fromEntries(bookingQuestionsAndAnswers.map(qa => [qa.question, qa.answer])) },
			earlyEventTypeConfig,
		);
		const effectivePhone =
			extractedIdentifiers.phoneOverride ?? inviteePhone;
		const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
			extractHostMembership(scheduledEvent);
		const assignedCloserResolution = await resolveAssignedCloser(
			ctx,
			tenantId,
			hostUserUri,
		);
		const assignedCloserId = assignedCloserResolution.assignedCloserId;

		// Resolve the opportunity before rejecting the host: a follow-up or
		// reschedule can retain the opportunity's already assigned closer.
		if (utmParams?.utm_source === "ptdom" && utmParams.utm_campaign) {

			const targetOpportunityId = ctx.db.normalizeId("opportunities", utmParams.utm_campaign);
      if (!targetOpportunityId) blockBooking("invalid_booking_link");
			const isNoShowRescheduleUtm =
				utmParams.utm_medium === "noshow_resched";
			const targetFollowUpId =
				!isNoShowRescheduleUtm && utmParams.utm_content
					? (ctx.db.normalizeId("followUps", utmParams.utm_content) ?? blockBooking("invalid_booking_link"))
					: undefined;
			const targetOpportunity = await ctx.db.get("opportunities", targetOpportunityId);
      if (!targetOpportunity || targetOpportunity.tenantId !== tenantId) blockBooking("invalid_booking_link");
      if (targetOpportunity.updatedAt > now) blockBooking("historical_booking_requires_review");

			if (
				targetOpportunity &&
				targetOpportunity.tenantId === tenantId &&
				(targetOpportunity.status === "follow_up_scheduled" ||
					targetOpportunity.status === "reschedule_link_sent") &&
				validateTransition(targetOpportunity.status, "scheduled")
			) {
				const previousTargetStatus = targetOpportunity.status;
				const targetLead = await ctx.db.get("leads", targetOpportunity.leadId);
        const resolvedTarget = await resolveExistingLeadIdentity(ctx, { tenantId, email: inviteeEmail, phone: effectivePhone,
          socialHandle: extractedIdentifiers.socialHandle, identifierSource: "calendly_booking", createdAt: now });
        if (resolvedTarget && resolvedTarget.leadId !== targetOpportunity.leadId) blockBooking("identity_conflict");
        // A different email is accepted only when the identity lookup tied it
        // to the target lead (a known email, or a handle vouching for a new one),
        // the same rule a booking without a link gets.
        if (!resolvedTarget && targetLead?.email && normalizeEmail(targetLead.email) !== inviteeEmail) blockBooking("identity_conflict");
				if (!targetLead || targetLead.tenantId !== tenantId) {
					reportError(
						"pipeline.data_inconsistency",
						new Error("UTM target opportunity references a missing lead"),
						{
							severity: "error",
							fingerprint: "pipeline.data_inconsistency:utm_target_lead_missing",
							reason: "utm_target_lead_missing",
							tenantId,
							rawEventId,
							opportunityId: targetOpportunityId,
							leadId: targetOpportunity.leadId,
							leadExists: !!targetLead,
						},
					);
				} else {
					const lead = await syncLeadFromBooking(ctx, targetLead, {
						inviteeEmail,
						inviteeName,
						inviteePhone: effectivePhone,
						latestCustomFields,
						now,
					});
					await updateLeadSearchText(ctx, lead._id);
					const eventTypeConfigId = await resolveEventTypeConfigId(
						ctx,
						{
							tenantId,
							eventTypeUri,
							scheduledEvent,
							latestCustomFields,
							now,
							preloadedConfig: earlyEventTypeConfig,
						},
					);
					const effectiveEventTypeConfigId =
						eventTypeConfigId ??
						targetOpportunity.eventTypeConfigId ??
						undefined;
					const nextAssignedCloserId =
						assignedCloserId ?? targetOpportunity.assignedCloserId;
					const closerChanged =
						nextAssignedCloserId !==
						targetOpportunity.assignedCloserId;
					if (!nextAssignedCloserId) {
						log.warn("pipeline.invitee_created.rejected", {
							reason: "no_assigned_closer",
							path: "utm_relink",
							tenantId,
							rawEventId,
							opportunityId: targetOpportunityId,
							closerResolution: assignedCloserResolution.resolution,
						});
						blockBooking("host_not_linked");
					}

					await transitionOpportunity(ctx, targetOpportunityId, {
						to: "scheduled",
						fields: {
							calendlyEventUri,
							assignedCloserId: nextAssignedCloserId,
							hostCalendlyUserUri: hostUserUri,
							hostCalendlyEmail,
							hostCalendlyName,
							eventTypeConfigId: effectiveEventTypeConfigId,
							updatedAt: now,
						},
						source: "pipeline",
						occurredAt: now,
					});
					if (closerChanged) {
						await syncOpportunityMeetingsAssignedCloser(
							ctx,
							targetOpportunityId,
							nextAssignedCloserId,
						);
					}

					let rescheduledFromMeetingId: Id<"meetings"> | undefined;
					if (isNoShowRescheduleUtm && utmParams.utm_content) {
						const candidateMeetingId =
							ctx.db.normalizeId("meetings", utmParams.utm_content) ?? blockBooking("invalid_booking_link");
						const originalMeeting = await ctx.db.get(
							"meetings", candidateMeetingId,
						);
						if (originalMeeting && originalMeeting.tenantId === tenantId && originalMeeting.opportunityId === targetOpportunityId) {
							rescheduledFromMeetingId = originalMeeting._id;
						} else {
							blockBooking("invalid_booking_link");
						}
					}

					if (targetFollowUpId) {
						const followUp = await ctx.db.get("followUps", targetFollowUpId);
						if (
							followUp &&
							followUp.tenantId === tenantId &&
							followUp.status === "pending" &&
							followUp.opportunityId === targetOpportunityId &&
							followUp.type !== "manual_reminder"
						) {
							const bookedAt = now;
							await ctx.db.patch("followUps", targetFollowUpId, {
								status: "booked",
								calendlyEventUri,
								bookedAt,
							});
							await emitDomainEvent(ctx, {
								tenantId,
								entityType: "followUp",
								entityId: targetFollowUpId,
								eventType: "followUp.booked",
								source: "pipeline",
								fromStatus: followUp.status,
								toStatus: "booked",
								occurredAt: bookedAt,
							});
						} else {
							blockBooking("invalid_booking_link");
						}
					} else {
						await ctx.runMutation(
							internal.closer.followUpMutations
								.markFollowUpBooked,
							{
								opportunityId: targetOpportunityId,
								calendlyEventUri,
                occurredAt: now,
							},
						);
					}

					const meetingLocation = extractMeetingLocation(
						scheduledEvent.location,
					);
					const meetingNotes = getString(
						scheduledEvent,
						"meeting_notes_plain",
					);
					const effectiveEventTypeConfig = await loadEventTypeConfig(
						ctx,
						effectiveEventTypeConfigId,
					);

					const meetingId = await ctx.db.insert("meetings", {
						tenantId,
						opportunityId: targetOpportunityId,
						assignedCloserId: nextAssignedCloserId,
						calendlyEventUri,
						calendlyInviteeUri,
						zoomJoinUrl: meetingLocation.zoomJoinUrl,
						meetingJoinUrl: meetingLocation.meetingJoinUrl,
						meetingLocationType:
							meetingLocation.meetingLocationType,
						scheduledAt,
						durationMinutes,
						status: "scheduled",
						callClassification:
							await getCallClassificationForOpportunity(
								ctx,
								targetOpportunityId,
							),
						notes: meetingNotes,
						leadName: lead.fullName ?? lead.email,
						createdAt: now,
						utmParams,
						utmTruncated,
						...bookedProgramPatch(effectiveEventTypeConfig),
						...resolutionPatch(resolvedAttribution),
						rescheduledFromMeetingId,
					});
					await recordMeetingBookingAttribution(
						ctx,
						meetingId,
						resolvedAttribution,
					);
					await patchFirstExternalBookingCaches(ctx, {
						opportunity: targetOpportunity,
						meetingId,
						scheduledAt,
						eventTypeConfig: effectiveEventTypeConfig,
						utmParams,
					});
					await insertMeetingAggregate(ctx, meetingId);
					await recordMeeting(ctx, meetingId);
					await syncMeetingFormResponsesForBooking(ctx, {
						tenantId,
						meetingId,
						opportunityId: targetOpportunityId,
						leadId: lead._id,
						eventTypeConfigId: effectiveEventTypeConfigId,
						questionsAndAnswers: bookingQuestionsAndAnswers,
						capturedAt: rawEvent.receivedAt,
					});
					await emitDomainEvent(ctx, {
						tenantId,
						entityType: "meeting",
						entityId: meetingId,
						eventType: "meeting.created",
						source: "pipeline",
						toStatus: "scheduled",
						metadata: {
							opportunityId: targetOpportunityId,
						},
						occurredAt: now,
					});

					await updateOpportunityMeetingRefs(
						ctx,
						targetOpportunityId,
					);
					await rebuildQualificationRowsForOpportunity(
						ctx,
						targetOpportunityId,
					);
					await createLeadIdentifiers(
						ctx,
						tenantId,
						lead._id,
						meetingId,
						inviteeEmail,
						rawInviteeEmail,
						effectivePhone,
						extractedIdentifiers.socialHandle,
						now,
					);
					await updateLeadSearchText(ctx, lead._id);
					await syncKnownCustomFieldKeys(
						ctx,
						effectiveEventTypeConfigId,
						latestCustomFields,
					);

					await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
					log.info("pipeline.invitee_created.processed", {
						path: "utm_relink",
						tenantId,
						rawEventId,
						meetingId,
						opportunityId: targetOpportunityId,
						leadId: lead._id,
						leadCreated: false,
						opportunityCreated: false,
						previousOpportunityStatus: previousTargetStatus,
						closerResolution: assignedCloserResolution.resolution,
						closerChanged,
						rescheduledFromMeetingId,
						followUpId: targetFollowUpId,
					});
					return;
				}
			}

			log.warn("pipeline.invitee_created.utm_target_invalid", {
				tenantId,
				rawEventId,
				opportunityId: targetOpportunityId,
				opportunityExists: !!targetOpportunity,
				tenantMatch: targetOpportunity?.tenantId === tenantId,
				opportunityStatus: targetOpportunity?.status,
			});
		  blockBooking("invalid_booking_link");
		}


		// A provider reschedule of a booking without a meeting gets the outcome
		// its host would give the original booking. Only a closer's booking is
		// genuinely missing. Checked before lead resolution so an ignored
		// reschedule writes nothing.
		const oldInvitee = getString(payload, "old_invitee");
		const previousMeeting = oldInvitee
			? await ctx.db
					.query("meetings")
					.withIndex("by_tenantId_and_calendlyInviteeUri", (q) =>
						q.eq("tenantId", tenantId).eq("calendlyInviteeUri", oldInvitee),
					)
					.unique()
			: null;
		if (oldInvitee && !previousMeeting) {
			const hostOutcome = bookingHostOutcome(
				assignedCloserResolution,
				await isProgramEventType(ctx, tenantId, eventTypeUri),
			);
			if (hostOutcome.status === "ignored") {
				logNonCloserHostSkip({
					reason: "non_closer_host_untracked_reschedule",
					outcome: hostOutcome,
					tenantId,
					rawEventId,
					closerResolution: assignedCloserResolution.resolution,
					hostCalendlyRole: assignedCloserResolution.hostCalendlyRole,
				});
				ignoreBooking(hostOutcome.reason);
			}
			if (hostOutcome.status === "blocked") blockBooking(hostOutcome.reason);
		}

		// === Feature E: Multi-identifier identity resolution ===
		const resolution = await resolveLeadIdentity(ctx, {
			tenantId,
			email: inviteeEmail,
			fullName: inviteeName,
			phone: effectivePhone,
			socialHandle: extractedIdentifiers.socialHandle,
			identifierSource: "calendly_booking",
			createdAt: now,
			createIdentifiers: false,
			initialLifecycle: { stage: "booked", at: now },
		});

		let lead = resolution.lead;

		// If existing lead, update fields (existing behavior, preserved)
		if (!resolution.isNewLead) {
			lead = await syncLeadFromBooking(ctx, lead, {
				inviteeEmail,
				inviteeName,
				inviteePhone: effectivePhone,
				latestCustomFields,
				now,
			});
			await updateLeadSearchText(ctx, lead._id);
		} else if (latestCustomFields) {
			// New lead: set custom fields (they were not set in resolveLeadIdentity)
			await ctx.db.patch("leads", lead._id, {
				customFields: latestCustomFields,
			});
			await syncCustomerSnapshot(ctx, tenantId, lead._id);
		}
		if (resolution.isNewLead) {
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "lead",
				entityId: lead._id,
				eventType: "lead.created",
				source: "pipeline",
				toStatus: "active",
				occurredAt: now,
			});
		}
		// === End Feature E: Identity Resolution ===
		const eventTypeConfigId = await resolveEventTypeConfigId(ctx, {
			tenantId,
			eventTypeUri,
			scheduledEvent,
			latestCustomFields,
			now,
			preloadedConfig: earlyEventTypeConfig,
		});

		// === Feature B4: Heuristic reschedule detection ===
		let autoRescheduleTarget: Doc<"opportunities"> | null = null;
		const rescheduleCutoff = now - RESCHEDULE_WINDOW_MS;
    const candidates = await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", q => q.eq("tenantId", tenantId).eq("leadId", lead._id)).order("desc").take(129);
    if (candidates.length > 128) blockBooking("booking_history_requires_review");
    // A deal changed after this booking happened makes it historical: what the
    // booking does depends on the deals' statuses at the time. Two changes
    // don't. The stale expiry can close a Slack deal after this booking
    // happened, and the Slack join below reopens it. And a deal that was
    // booked or won at the time was out of this booking's reach, whatever
    // happened to it since (a person books a new slot, then cancels the old
    // one, and the booking is retried after the cancel). Such a deal is left
    // out of the lookups below, which read current statuses. A provider
    // reschedule's own deal must not have changed.
    const changed = candidates.filter(o => o.updatedAt > now && !wasStaleExpiredAfter(o, now));
    if (changed.length > MAX_CHANGED_DEALS) blockBooking("historical_booking_requires_review");
    const outOfReach = new Set<Id<"opportunities">>();
    for (const o of changed) {
      if (o._id === previousMeeting?.opportunityId || !(await wasUnattachableAt(ctx, o, now))) blockBooking("historical_booking_requires_review");
      outOfReach.add(o._id);
    }
    const reachable = candidates.filter(o => !outOfReach.has(o._id));
    let explicitSourceMeeting: Doc<"meetings"> | undefined;
    if (oldInvitee) {
      if (!previousMeeting) blockBooking("previous_booking_missing");
      explicitSourceMeeting = previousMeeting;
      autoRescheduleTarget = candidates.find(o => o._id === previousMeeting.opportunityId) ?? null;
      if (!autoRescheduleTarget) blockBooking("identity_conflict");
      if (!["scheduled", "canceled", "no_show"].includes(autoRescheduleTarget.status)) blockBooking("booking_target_requires_review");
    } else {
      // A Slack qualification inside the join window outranks the time-window
      // guess: the setter just handed this person off, so the booking belongs
      // to that deal. The Slack join below picks it up.
      const freshSlackQualification = await findOpenSlackQualifiedOpportunity(ctx, {
        tenantId,
        leadId: lead._id,
        referenceTime: now,
      });
      if (!freshSlackQualification) {
        const eligible = reachable.filter(o => (o.status === "no_show" || o.status === "canceled") && o.updatedAt > rescheduleCutoff);
        if (eligible.length > 1) blockBooking("ambiguous_booking_target");
        autoRescheduleTarget = eligible[0] ?? null;
      }
    }

		if (
			autoRescheduleTarget && autoRescheduleTarget.status !== "scheduled" &&
			!validateTransition(autoRescheduleTarget.status, "scheduled")
		) {
			log.warn("pipeline.invitee_created.reschedule_transition_invalid", {
				tenantId,
				rawEventId,
				opportunityId: autoRescheduleTarget._id,
				opportunityStatus: autoRescheduleTarget.status,
			});
			autoRescheduleTarget = null;
		}
		// === End Feature B4: Heuristic reschedule detection ===

		// === Feature B4: Opportunity linking + closer reassignment ===
		if (autoRescheduleTarget) {
			const reschedOpportunityId = autoRescheduleTarget._id;
			const previousOpportunityStatus = autoRescheduleTarget.status;
			const previousMeetings = await ctx.db
				.query("meetings")
				.withIndex("by_opportunityId", (q) =>
					q.eq("opportunityId", reschedOpportunityId),
				)
				.order("desc")
				.take(1);
			const rescheduledFromMeetingId = explicitSourceMeeting?._id ?? previousMeetings[0]?._id;
      if (explicitSourceMeeting?.status === "scheduled") {
        await patchMeetingLifecycle(ctx, explicitSourceMeeting._id, { status: "canceled", canceledAt: now });
        await emitDomainEvent(ctx, { tenantId, entityType: "meeting", entityId: explicitSourceMeeting._id,
          eventType: "meeting.canceled", source: "pipeline", fromStatus: "scheduled", toStatus: "canceled", occurredAt: now });
      }
			const nextAssignedCloserId =
				assignedCloserId ?? autoRescheduleTarget.assignedCloserId;
			const effectiveEventTypeConfigId =
				eventTypeConfigId ??
				autoRescheduleTarget.eventTypeConfigId ??
				undefined;
			const closerChanged =
				nextAssignedCloserId !== autoRescheduleTarget.assignedCloserId;
			if (!nextAssignedCloserId) {
				log.warn("pipeline.invitee_created.rejected", {
					reason: "no_assigned_closer",
					path: "heuristic_reschedule",
					tenantId,
					rawEventId,
					opportunityId: reschedOpportunityId,
					closerResolution: assignedCloserResolution.resolution,
				});
				blockBooking("host_not_linked");
			}

			const rebookFields = {
				calendlyEventUri,
				assignedCloserId: nextAssignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId: effectiveEventTypeConfigId,
				updatedAt: now,
			};
			// A Calendly reschedule of a booking that is still scheduled moves
			// the booking, not the status.
			if (previousOpportunityStatus === "scheduled") {
				await patchOpportunityLifecycle(ctx, reschedOpportunityId, rebookFields);
			} else {
				await transitionOpportunity(ctx, reschedOpportunityId, {
					to: "scheduled",
					fields: rebookFields,
					source: "pipeline",
					occurredAt: now,
				});
			}
			if (closerChanged) {
				await syncOpportunityMeetingsAssignedCloser(
					ctx,
					reschedOpportunityId,
					nextAssignedCloserId,
				);
			}

			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId: reschedOpportunityId,
					calendlyEventUri,
          occurredAt: now,
				},
			);

			const meetingLocation = extractMeetingLocation(scheduledEvent.location);
			const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");
			const effectiveEventTypeConfig = await loadEventTypeConfig(
				ctx,
				effectiveEventTypeConfigId,
			);
			const meetingId = await ctx.db.insert("meetings", {
				tenantId,
				opportunityId: reschedOpportunityId,
				assignedCloserId: nextAssignedCloserId,
				calendlyEventUri,
				calendlyInviteeUri,
				zoomJoinUrl: meetingLocation.zoomJoinUrl,
				meetingJoinUrl: meetingLocation.meetingJoinUrl,
				meetingLocationType: meetingLocation.meetingLocationType,
				scheduledAt,
				durationMinutes,
				status: "scheduled",
				callClassification: await getCallClassificationForOpportunity(
					ctx,
					reschedOpportunityId,
				),
				notes: meetingNotes,
				leadName: lead.fullName ?? lead.email,
				createdAt: now,
				utmParams,
				utmTruncated,
				...bookedProgramPatch(effectiveEventTypeConfig),
				...resolutionPatch(resolvedAttribution),
				rescheduledFromMeetingId,
			});
			await recordMeetingBookingAttribution(ctx, meetingId, resolvedAttribution);
			await patchFirstExternalBookingCaches(ctx, {
				opportunity: autoRescheduleTarget,
				meetingId,
				scheduledAt,
				eventTypeConfig: effectiveEventTypeConfig,
				utmParams,
			});
			await insertMeetingAggregate(ctx, meetingId);
			await recordMeeting(ctx, meetingId);
			await syncMeetingFormResponsesForBooking(ctx, {
				tenantId,
				meetingId,
				opportunityId: reschedOpportunityId,
				leadId: lead._id,
				eventTypeConfigId: effectiveEventTypeConfigId,
				questionsAndAnswers: bookingQuestionsAndAnswers,
				capturedAt: rawEvent.receivedAt,
			});
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "meeting",
				entityId: meetingId,
				eventType: "meeting.created",
				source: "pipeline",
				toStatus: "scheduled",
				metadata: {
					opportunityId: reschedOpportunityId,
				},
				occurredAt: now,
			});

			await updateOpportunityMeetingRefs(ctx, reschedOpportunityId);
			await rebuildQualificationRowsForOpportunity(ctx, reschedOpportunityId);
			await createLeadIdentifiers(
				ctx,
				tenantId,
				lead._id,
				meetingId,
				inviteeEmail,
				rawInviteeEmail,
				effectivePhone,
				extractedIdentifiers.socialHandle,
				now,
			);
			await updateLeadSearchText(ctx, lead._id);
			await syncKnownCustomFieldKeys(
				ctx,
				effectiveEventTypeConfigId,
				latestCustomFields,
			);

			await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
			log.info("pipeline.invitee_created.processed", {
				path: "heuristic_reschedule",
				tenantId,
				rawEventId,
				meetingId,
				opportunityId: reschedOpportunityId,
				leadId: lead._id,
				leadCreated: resolution.isNewLead,
				opportunityCreated: false,
				previousOpportunityStatus,
				closerResolution: assignedCloserResolution.resolution,
				closerChanged,
				rescheduledFromMeetingId,
				identityResolvedVia: resolution.resolvedVia,
			});
			return;
		}
		// === End Feature B4: Opportunity linking + closer reassignment ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
    const followUps = reachable.filter(o => o.status === "follow_up_scheduled");
    if (followUps.length > 1) blockBooking("ambiguous_booking_target");
    existingFollowUp = followUps[0] ?? null;

		const slackQualifiedOpportunity =
			await findOpenSlackQualifiedOpportunity(ctx, {
				tenantId,
				leadId: lead._id,
        referenceTime: now,
			});
    if (existingFollowUp && slackQualifiedOpportunity) blockBooking("ambiguous_booking_target");

		const meetingAssignedCloserId = slackQualifiedOpportunity
			? assignedCloserId ??
				slackQualifiedOpportunity.assignedCloserId ??
				existingFollowUp?.assignedCloserId
			: existingFollowUp
				? assignedCloserId ?? existingFollowUp.assignedCloserId
				: assignedCloserId;
		if (!meetingAssignedCloserId) {
			const hostOutcome = bookingHostOutcome(
				assignedCloserResolution,
				await isProgramEventType(ctx, tenantId, eventTypeUri),
			);
			if (
				!slackQualifiedOpportunity && !existingFollowUp &&
				hostOutcome.status === "ignored"
			) {
				// Thrown, so the lead resolved above rolls back with the rest of
				// this booking's writes: an untracked booking leaves no lead behind.
				logNonCloserHostSkip({
					reason: "non_closer_host_without_opportunity",
					outcome: hostOutcome,
					tenantId,
					rawEventId,
					closerResolution: assignedCloserResolution.resolution,
					hostCalendlyRole: assignedCloserResolution.hostCalendlyRole,
				});
				ignoreBooking(hostOutcome.reason);
			}
			log.warn("pipeline.invitee_created.rejected", {
				reason: "no_assigned_closer",
				path: slackQualifiedOpportunity
					? "slack_qualified"
					: existingFollowUp
						? "follow_up"
						: "new_opportunity",
				tenantId,
				rawEventId,
				// A new lead rolls back with the blocked booking.
				leadId: resolution.isNewLead ? undefined : lead._id,
				closerResolution: assignedCloserResolution.resolution,
			});
			blockBooking(
				hostOutcome.status === "blocked" ? hostOutcome.reason : "host_not_linked",
			);
		}

		let opportunityId: Id<"opportunities">;
		let meetingEventTypeConfigId: Id<"eventTypeConfigs"> | undefined =
			eventTypeConfigId;
		let slackJoinEventOpportunityId: Id<"opportunities"> | undefined;
		let createdOpportunityId: Id<"opportunities"> | undefined;
		if (slackQualifiedOpportunity) {
			const reopensStaleDeal = wasStaleExpiredAfter(slackQualifiedOpportunity, now);
			if (
				!reopensStaleDeal &&
				!validateTransition(slackQualifiedOpportunity.status, "scheduled")
			) {
				throw new Error(
					"[Pipeline] Invalid slack-qualified opportunity transition to scheduled",
				);
			}

			opportunityId = slackQualifiedOpportunity._id;
			meetingEventTypeConfigId =
				eventTypeConfigId ??
				slackQualifiedOpportunity.eventTypeConfigId ??
				undefined;
			const nextAssignedCloserId =
				assignedCloserId ??
				slackQualifiedOpportunity.assignedCloserId ??
				meetingAssignedCloserId;
			const closerChanged =
				nextAssignedCloserId !==
				slackQualifiedOpportunity.assignedCloserId;
			await transitionOpportunity(ctx, opportunityId, {
				to: "scheduled",
				fields: {
					calendlyEventUri,
					assignedCloserId: nextAssignedCloserId,
					hostCalendlyUserUri: hostUserUri,
					hostCalendlyEmail,
					hostCalendlyName,
					eventTypeConfigId: meetingEventTypeConfigId,
					updatedAt: now,
					...(reopensStaleDeal
						? { lostAt: undefined, lostReason: undefined, lostByUserId: undefined }
						: {}),
					// NOTE: utmParams intentionally NOT included here.
					// The opportunity preserves attribution from its Slack qualification.
					// The new meeting stores its own UTMs independently.
				},
				source: "pipeline",
				occurredAt: now,
				...(reopensStaleDeal ? { exception: "slack_stale_rejoin" as const } : {}),
			});
			if (closerChanged) {
				await syncOpportunityMeetingsAssignedCloser(
					ctx,
					opportunityId,
					nextAssignedCloserId,
				);
			}
			await preserveQualificationAuditMatchForScheduledMeeting(ctx, {
				tenantId,
				leadId: lead._id,
				opportunityId,
				now,
			});
			slackJoinEventOpportunityId = opportunityId;
		} else if (existingFollowUp) {
			if (!validateTransition(existingFollowUp.status, "scheduled")) {
				throw new Error(
					"[Pipeline] Invalid follow-up opportunity transition",
				);
			}

			opportunityId = existingFollowUp._id;
			meetingEventTypeConfigId =
				eventTypeConfigId ??
				existingFollowUp.eventTypeConfigId ??
				undefined;
			const nextAssignedCloserId =
				assignedCloserId ?? existingFollowUp.assignedCloserId;
			const closerChanged =
				nextAssignedCloserId !== existingFollowUp.assignedCloserId;
			await transitionOpportunity(ctx, opportunityId, {
				to: "scheduled",
				fields: {
					calendlyEventUri,
					assignedCloserId: nextAssignedCloserId,
					hostCalendlyUserUri: hostUserUri,
					hostCalendlyEmail,
					hostCalendlyName,
					eventTypeConfigId: meetingEventTypeConfigId,
					updatedAt: now,
					// NOTE: utmParams intentionally NOT included here.
					// The opportunity preserves attribution from its original creation.
					// The new meeting stores its own UTMs independently.
				},
				source: "pipeline",
				occurredAt: now,
			});
			if (closerChanged) {
				await syncOpportunityMeetingsAssignedCloser(
					ctx,
					opportunityId,
					nextAssignedCloserId,
				);
			}

			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId,
					calendlyEventUri,
          occurredAt: now,
				},
			);
		} else {
			// Lead Gen Ops intentionally does not search prospect history for
			// cold Calendly bookings; only Slack qualification creates matches.
			opportunityId = await ctx.db.insert("opportunities", {
				tenantId,
				leadId: lead._id,
				assignedCloserId: meetingAssignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId,
				status: "scheduled",
				source: "calendly",
				calendlyEventUri,
				createdAt: now,
				updatedAt: now,
				latestActivityAt: now,
				utmParams,
				potentialDuplicateLeadId: resolution.potentialDuplicateLeadId,
			});
			createdOpportunityId = opportunityId;
			await insertOpportunityAggregate(ctx, opportunityId);
			await updateTenantStats(ctx, tenantId, {
				totalOpportunities: 1,
				activeOpportunities: 1,
			});
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "opportunity",
				entityId: opportunityId,
				eventType: "opportunity.created",
				source: "pipeline",
				toStatus: "scheduled",
				metadata: {
					leadId: lead._id,
				},
				occurredAt: now,
			});
		}

		const meetingLocation = extractMeetingLocation(scheduledEvent.location);
		const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");
		const meetingEventTypeConfig = await loadEventTypeConfig(
			ctx,
			meetingEventTypeConfigId,
		);
		const opportunityForFirstBooking = await ctx.db.get("opportunities", opportunityId);
		if (!opportunityForFirstBooking) {
			throw new Error("[Pipeline] Opportunity disappeared before meeting insert");
		}

		const meetingId = await ctx.db.insert("meetings", {
			tenantId,
			opportunityId,
			assignedCloserId: meetingAssignedCloserId,
			calendlyEventUri,
			calendlyInviteeUri,
			zoomJoinUrl: meetingLocation.zoomJoinUrl,
			meetingJoinUrl: meetingLocation.meetingJoinUrl,
			meetingLocationType: meetingLocation.meetingLocationType,
			scheduledAt,
			durationMinutes,
			status: "scheduled",
			callClassification: await getCallClassificationForOpportunity(
				ctx,
				opportunityId,
			),
			notes: meetingNotes,
			leadName: lead.fullName ?? lead.email, // Denormalize for query efficiency
			createdAt: now,
			utmParams,
			utmTruncated,
			...bookedProgramPatch(meetingEventTypeConfig),
			...resolutionPatch(resolvedAttribution),
		});
		await recordMeetingBookingAttribution(ctx, meetingId, resolvedAttribution);
		await patchFirstExternalBookingCaches(ctx, {
			opportunity: opportunityForFirstBooking,
			meetingId,
			scheduledAt,
			eventTypeConfig: meetingEventTypeConfig,
			utmParams,
		});
		await insertMeetingAggregate(ctx, meetingId);
		await recordMeeting(ctx, meetingId);
		await syncMeetingFormResponsesForBooking(ctx, {
			tenantId,
			meetingId,
			opportunityId,
			leadId: lead._id,
			eventTypeConfigId: meetingEventTypeConfigId,
			questionsAndAnswers: bookingQuestionsAndAnswers,
			capturedAt: rawEvent.receivedAt,
		});
		await emitDomainEvent(ctx, {
			tenantId,
			entityType: "meeting",
			entityId: meetingId,
			eventType: "meeting.created",
			source: "pipeline",
			toStatus: "scheduled",
			metadata: {
				opportunityId,
			},
			occurredAt: now,
		});
		// A new Calendly deal's snapshot includes the booking that created it,
		// so it runs after meeting.created. A deal this booking joined keeps
		// the one it got when it was created.
		if (createdOpportunityId) {
			await recordDealCreation(ctx, createdOpportunityId);
		}
		if (slackJoinEventOpportunityId) {
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "opportunity",
				entityId: slackJoinEventOpportunityId,
				eventType: "slack_qualified_lead_booked",
				source: "pipeline",
				// transitionOpportunity recorded the status change.
				metadata: {
					leadId: lead._id,
					meetingId,
				},
				occurredAt: now,
			});
		}

		// Update denormalized meeting refs on opportunity for efficient queries
		await updateOpportunityMeetingRefs(ctx, opportunityId);
		await rebuildQualificationRowsForOpportunity(ctx, opportunityId);

		// === Feature E: Create leadIdentifier records ===
		await createLeadIdentifiers(
			ctx,
			tenantId,
			lead._id,
			meetingId,
			inviteeEmail,
			rawInviteeEmail,
			effectivePhone,
			extractedIdentifiers.socialHandle,
			now,
		);
		await updateLeadSearchText(ctx, lead._id);
		// === End Feature E ===

		await syncKnownCustomFieldKeys(
			ctx,
			meetingEventTypeConfigId,
			latestCustomFields,
		);

		await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: true });
		log.info("pipeline.invitee_created.processed", {
			path: slackQualifiedOpportunity
				? "slack_qualified"
				: existingFollowUp
					? "follow_up"
					: "new_opportunity",
			tenantId,
			rawEventId,
			meetingId,
			opportunityId,
			leadId: lead._id,
			leadCreated: resolution.isNewLead,
			opportunityCreated: !slackQualifiedOpportunity && !existingFollowUp,
			closerResolution: assignedCloserResolution.resolution,
			identityResolvedVia: resolution.resolvedVia,
			potentialDuplicateLead: resolution.potentialDuplicateLeadId !== undefined,
			durationMinutes,
		});
	},
});
