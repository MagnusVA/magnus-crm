import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";
import { extractUtmParams } from "../lib/utmParams";
import { extractMeetingLocation } from "../lib/meetingLocation";
import {
	extractQuestionsAndAnswers,
	toQuestionAnswerRecord,
	writeMeetingFormResponses,
} from "../lib/meetingFormResponses";
import { emitDomainEvent } from "../lib/domainEvents";
import { isRecord, getString } from "../lib/payloadExtraction";
import {
	normalizeEmail,
	normalizeSocialHandle,
	normalizePhone,
	areNamesSimilar,
	extractEmailDomain,
} from "../lib/normalization";
import type { IdentifierType, SocialPlatformType } from "../lib/normalization";
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";
import { syncOpportunityMeetingsAssignedCloser } from "../lib/syncOpportunityMeetingsAssignedCloser";
import {
	updateTenantStats,
	isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
import { buildLeadSearchText } from "../leads/searchTextBuilder";
import {
	insertLeadAggregate,
	insertMeetingAggregate,
	insertOpportunityAggregate,
	replaceOpportunityAggregate,
} from "../reporting/writeHooks";

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

	const result = await writeMeetingFormResponses(ctx, args);
	console.log(
		`[Pipeline:invitee.created] Meeting form responses synced | meetingId=${args.meetingId} responsesCreated=${result.responsesCreated} responsesUpdated=${result.responsesUpdated} fieldCatalogCreated=${result.fieldCatalogCreated} fieldCatalogUpdated=${result.fieldCatalogUpdated} questionsSkipped=${result.questionsSkipped}`,
	);
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

/**
 * Result of multi-identifier identity resolution.
 */
type IdentityResolutionResult = {
	lead: Doc<"leads">;
	isNewLead: boolean;
	resolvedVia: "email" | "social_handle" | "phone" | "new";
	potentialDuplicateLeadId?: Id<"leads">;
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
			console.log(
				`[Pipeline:Identity] Social handle extracted from custom field | field="${mappings.socialHandleField}" platform=${mappings.socialHandleType} rawValue="${rawValue.trim()}"`,
			);
		}
	}

	// Phone override extraction
	if (mappings.phoneField) {
		const rawValue = customFields[mappings.phoneField];
		if (rawValue && rawValue.trim().length > 0) {
			result.phoneOverride = rawValue.trim();
			console.log(
				`[Pipeline:Identity] Phone override extracted from custom field | field="${mappings.phoneField}" rawValue="${rawValue.trim()}"`,
			);
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
			console.warn(
				`[Pipeline:Identity] Identifier conflict: ${record.type}=${record.value} exists on leadId=${existing.leadId}, attempted to add to leadId=${record.leadId}`,
			);
			return "existing_other_lead";
		}
		return "existing_same_lead";
	}

	await ctx.db.insert("leadIdentifiers", record);
	console.log(
		`[Pipeline:Identity] Identifier created | type=${record.type} value=${record.value} leadId=${record.leadId} confidence=${record.confidence}`,
	);
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
	const lead = await ctx.db.get(leadId);
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

	await ctx.db.patch(leadId, {
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
		inviteeName,
		inviteePhone,
		latestCustomFields,
		now,
	}: {
		inviteeName: string | undefined;
		inviteePhone: string | undefined;
		latestCustomFields: Record<string, string> | undefined;
		now: number;
	},
): Promise<Doc<"leads">> {
	const updatedLead: Doc<"leads"> = {
		...lead,
		fullName: inviteeName || lead.fullName,
		phone: inviteePhone || lead.phone,
		customFields: mergeCustomFields(lead.customFields, latestCustomFields),
		updatedAt: now,
	};

	await ctx.db.patch(lead._id, {
		fullName: updatedLead.fullName,
		phone: updatedLead.phone,
		customFields: updatedLead.customFields,
		updatedAt: now,
	});
	await syncCustomerSnapshot(ctx, lead.tenantId, lead._id);

	return updatedLead;
}

// ---------------------------------------------------------------------------
// Feature E: Identity Resolution Core (3B)
// ---------------------------------------------------------------------------

/** Public email domains excluded from fuzzy duplicate detection. */
const PUBLIC_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"yahoo.com",
	"hotmail.com",
	"outlook.com",
	"icloud.com",
	"aol.com",
	"protonmail.com",
	"mail.com",
	"live.com",
	"msn.com",
	"ymail.com",
	"zoho.com",
]);

/**
 * Follow the merge chain to find the active lead.
 * Max depth of 5 to prevent infinite loops from data corruption.
 */
async function followMergeChain(
	ctx: MutationCtx,
	lead: Doc<"leads">,
): Promise<Doc<"leads"> | undefined> {
	let current = lead;
	let depth = 0;
	const MAX_DEPTH = 5;

	while (
		current.status === "merged" &&
		current.mergedIntoLeadId &&
		depth < MAX_DEPTH
	) {
		const next = await ctx.db.get(current.mergedIntoLeadId);
		if (!next) {
			console.error(
				`[Pipeline:Identity] Broken merge chain at depth=${depth} | leadId=${current._id} mergedIntoLeadId=${current.mergedIntoLeadId}`,
			);
			return undefined;
		}
		current = next;
		depth++;
	}

	if (depth >= MAX_DEPTH) {
		console.error(
			`[Pipeline:Identity] Merge chain too deep (>${MAX_DEPTH}) | startLeadId=${lead._id}`,
		);
		return undefined;
	}

	// Skip if the final lead is still in "merged" state (broken chain)
	if (current.status === "merged") {
		return undefined;
	}

	return current;
}

/**
 * Detect potential duplicate leads using fuzzy matching.
 * Checks: same non-public email domain + similar name.
 * Bounded to 50 most recent leads to keep the hot path fast.
 */
async function detectPotentialDuplicate(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	newLeadName: string | undefined,
	newLeadEmail: string,
	newLeadId: Id<"leads">,
): Promise<Id<"leads"> | undefined> {
	if (!newLeadName) return undefined;

	const emailDomain = extractEmailDomain(newLeadEmail);
	if (!emailDomain) return undefined;

	if (PUBLIC_EMAIL_DOMAINS.has(emailDomain)) return undefined;

	const recentLeads = await ctx.db
		.query("leads")
		.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
		.order("desc")
		.take(50);

	for (const candidate of recentLeads) {
		if (candidate._id === newLeadId) continue;
		if (candidate.status === "merged" || candidate.status === "converted")
			continue;

		const candidateDomain = extractEmailDomain(candidate.email);
		if (candidateDomain !== emailDomain) continue;

		if (areNamesSimilar(newLeadName, candidate.fullName)) {
			console.log(
				`[Pipeline:Identity] Potential duplicate detected | newLeadId=${newLeadId} candidateLeadId=${candidate._id} domain=${emailDomain}`,
			);
			return candidate._id;
		}
	}

	return undefined;
}

/**
 * Multi-identifier lead identity resolution chain.
 * Priority: email > social handle > phone > new lead.
 */
async function resolveLeadIdentity(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	inviteeEmail: string,
	inviteeName: string | undefined,
	inviteePhone: string | undefined,
	socialHandle:
		| { rawValue: string; platform: SocialPlatformType }
		| undefined,
	now: number,
): Promise<IdentityResolutionResult> {
	// Step 1: Email match — legacy index first for backward compat
	const normalizedEmail = normalizeEmail(inviteeEmail);
	if (normalizedEmail) {
		const legacyLead = await ctx.db
			.query("leads")
			.withIndex("by_tenantId_and_email", (q) =>
				q.eq("tenantId", tenantId).eq("email", normalizedEmail),
			)
			.unique();

		if (legacyLead) {
			const activeLead = await followMergeChain(ctx, legacyLead);
			if (activeLead) {
				console.log(
					`[Pipeline:Identity] Email match via legacy index | leadId=${activeLead._id} email=${normalizedEmail}`,
				);
				return {
					lead: activeLead,
					isNewLead: false,
					resolvedVia: "email",
				};
			}
		}

		const emailIdentifier = await ctx.db
			.query("leadIdentifiers")
			.withIndex("by_tenantId_and_type_and_value", (q) =>
				q
					.eq("tenantId", tenantId)
					.eq("type", "email")
					.eq("value", normalizedEmail),
			)
			.first();

		if (emailIdentifier) {
			const matchedLead = await ctx.db.get(emailIdentifier.leadId);
			if (matchedLead && matchedLead.tenantId === tenantId) {
				const activeLead = await followMergeChain(ctx, matchedLead);
				if (activeLead) {
					console.log(
						`[Pipeline:Identity] Email match via leadIdentifiers | leadId=${activeLead._id} email=${normalizedEmail}`,
					);
					return {
						lead: activeLead,
						isNewLead: false,
						resolvedVia: "email",
					};
				}
			}
		}
	}

	// Step 2: Social handle match
	if (socialHandle) {
		const normalizedHandle = normalizeSocialHandle(
			socialHandle.rawValue,
			socialHandle.platform,
		);
		if (normalizedHandle) {
			const handleIdentifier = await ctx.db
				.query("leadIdentifiers")
				.withIndex("by_tenantId_and_type_and_value", (q) =>
					q
						.eq("tenantId", tenantId)
						.eq("type", socialHandle.platform)
						.eq("value", normalizedHandle),
				)
				.first();

			if (handleIdentifier) {
				const matchedLead = await ctx.db.get(handleIdentifier.leadId);
				if (matchedLead && matchedLead.tenantId === tenantId) {
					const activeLead = await followMergeChain(ctx, matchedLead);
					if (activeLead) {
						console.log(
							`[Pipeline:Identity] Social handle match | leadId=${activeLead._id} platform=${socialHandle.platform} handle=${normalizedHandle}`,
						);
						return {
							lead: activeLead,
							isNewLead: false,
							resolvedVia: "social_handle",
						};
					}
				}
			}
		}
	}

	// Step 3: Phone match
	if (inviteePhone) {
		const normalizedPhone = normalizePhone(inviteePhone);
		if (normalizedPhone) {
			const phoneIdentifier = await ctx.db
				.query("leadIdentifiers")
				.withIndex("by_tenantId_and_type_and_value", (q) =>
					q
						.eq("tenantId", tenantId)
						.eq("type", "phone")
						.eq("value", normalizedPhone),
				)
				.first();

			if (phoneIdentifier) {
				const matchedLead = await ctx.db.get(phoneIdentifier.leadId);
				if (matchedLead && matchedLead.tenantId === tenantId) {
					const activeLead = await followMergeChain(ctx, matchedLead);
					if (activeLead) {
						console.log(
							`[Pipeline:Identity] Phone match | leadId=${activeLead._id} phone=${normalizedPhone}`,
						);
						return {
							lead: activeLead,
							isNewLead: false,
							resolvedVia: "phone",
						};
					}
				}
			}
		}
	}

	// Step 4: No match — create a new lead
	// Note: customFields will be set separately in the main handler if present
	const leadId = await ctx.db.insert("leads", {
		tenantId,
		email: inviteeEmail,
		fullName: inviteeName,
		phone: inviteePhone,
		customFields: undefined,
		status: "active",
		firstSeenAt: now,
		updatedAt: now,
	});
	const newLead = (await ctx.db.get(leadId))!;
	await insertLeadAggregate(ctx, leadId);
	await updateTenantStats(ctx, tenantId, {
		totalLeads: 1,
	});
	await emitDomainEvent(ctx, {
		tenantId,
		entityType: "lead",
		entityId: leadId,
		eventType: "lead.created",
		source: "pipeline",
		toStatus: "active",
		occurredAt: now,
	});
	console.log(`[Pipeline:Identity] New lead created | leadId=${leadId}`);

	// Step 5: Check for potential duplicates (fuzzy match)
	const potentialDuplicateLeadId = await detectPotentialDuplicate(
		ctx,
		tenantId,
		inviteeName,
		inviteeEmail,
		leadId,
	);

	return {
		lead: newLead,
		isNewLead: true,
		resolvedVia: "new",
		potentialDuplicateLeadId,
	};
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

	// Email identifier (always created, "verified" confidence)
	if (normalizedEmail) {
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
	const lead = await ctx.db.get(leadId);
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
		await ctx.db.patch(leadId, { searchText });
	}
}

function extractHostMembership(scheduledEvent: Record<string, unknown>) {
	const eventMemberships = Array.isArray(scheduledEvent.event_memberships)
		? scheduledEvent.event_memberships
		: [];
	const primaryMembership = eventMemberships.find(isRecord);

	return {
		hostUserUri: primaryMembership
			? getString(primaryMembership, "user")
			: undefined,
		hostCalendlyEmail: primaryMembership
			? getString(primaryMembership, "user_email")
			: undefined,
		hostCalendlyName: primaryMembership
			? getString(primaryMembership, "user_name")
			: undefined,
	};
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

async function resolveAssignedCloserId(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	hostUserUri: string | undefined,
): Promise<Id<"users"> | undefined> {
	console.log(
		`[Pipeline:invitee.created] Resolving closer | hostUserUri=${hostUserUri ?? "none"}`,
	);

	if (!hostUserUri) {
		console.warn(
			"[Pipeline:invitee.created] No host URI on scheduled event; leaving opportunity unassigned",
		);
		return undefined;
	}

	const directUser = await ctx.db
		.query("users")
		.withIndex("by_tenantId_and_calendlyUserUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
		)
		.unique();
	if (directUser?.role === "closer") {
		console.log(
			`[Pipeline:invitee.created] Direct user match: userId=${directUser._id}`,
		);
		return directUser._id;
	}

	const orgMember = await ctx.db
		.query("calendlyOrgMembers")
		.withIndex("by_tenantId_and_calendlyUserUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
		)
		.unique();
	if (orgMember?.matchedUserId) {
		const matchedUser = await ctx.db.get(orgMember.matchedUserId);
		if (matchedUser?.role === "closer") {
			console.log(
				`[Pipeline:invitee.created] Org member match: userId=${matchedUser._id} via orgMemberId=${orgMember._id}`,
			);
			return matchedUser._id;
		}
	}

	console.warn(
		`[Pipeline:invitee.created] Unmatched Calendly host URI: ${hostUserUri}. Leaving opportunity unassigned.`,
	);
	return undefined;
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

	// Reuse preloaded config from early lookup if available, avoiding a duplicate query
	let existingConfig: Doc<"eventTypeConfigs"> | null;

	if (preloadedConfig !== undefined) {
		existingConfig = preloadedConfig;
	} else {
		const lookup = await lookupEventTypeConfig(ctx, {
			tenantId,
			eventTypeUri,
		});
		existingConfig = lookup.existingConfig;

		if (lookup.candidateCount > 1 && existingConfig) {
			console.warn(
				`[Pipeline:invitee.created] Multiple eventTypeConfigs for same URI (${lookup.candidateCount}); using canonical configId=${existingConfig._id}`,
			);
		}
	}

	if (existingConfig) {
		console.log(
			`[Pipeline:invitee.created] Event type config found | configId=${existingConfig._id}`,
		);
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
		createdAt: now,
		knownCustomFieldKeys:
			initialKeys && initialKeys.length > 0 ? initialKeys : undefined,
	});
	console.log(
		`[Pipeline:invitee.created] Event type config auto-created | configId=${eventTypeConfigId} displayName="${eventDisplayName}" initialKeys=${initialKeys ? JSON.stringify(initialKeys) : "none"}`,
	);

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

	const incomingKeys = Object.keys(latestCustomFields);
	if (incomingKeys.length === 0) {
		return;
	}

	const config = await ctx.db.get(eventTypeConfigId);
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
	await ctx.db.patch(eventTypeConfigId, {
		knownCustomFieldKeys: updatedKeys,
	});
	console.log(
		`[Pipeline:invitee.created] [Feature F] Auto-discovered ${newKeys.length} new custom field key(s) | configId=${eventTypeConfigId} newKeys=${JSON.stringify(newKeys)} totalKeys=${updatedKeys.length}`,
	);
}

export const process = internalMutation({
	args: {
		tenantId: v.id("tenants"),
		payload: v.any(),
		rawEventId: v.id("rawWebhookEvents"),
	},
	handler: async (ctx, { tenantId, payload, rawEventId }) => {
		console.log(
			`[Pipeline:invitee.created] Entry | tenantId=${tenantId} rawEventId=${rawEventId}`,
		);

		const rawEvent = await ctx.db.get(rawEventId);
		if (!rawEvent || rawEvent.processed) {
			console.log(
				`[Pipeline:invitee.created] Skipping: event already processed or not found`,
			);
			return;
		}

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

		console.log(
			`[Pipeline:invitee.created] Extracted fields | email=${inviteeEmail} name=${inviteeName} phone=${inviteePhone ? "provided" : "none"} calendlyEventUri=${calendlyEventUri} eventTypeUri=${eventTypeUri} scheduledAt=${scheduledAt} endTime=${endTime}`,
		);

		if (
			!inviteeEmail ||
			!rawInviteeEmail ||
			!calendlyInviteeUri ||
			!calendlyEventUri ||
			scheduledAt === undefined ||
			endTime === undefined
		) {
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
			console.log(
				`[Pipeline:invitee.created] Duplicate detected: meeting ${existingMeeting._id} already exists for eventUri=${calendlyEventUri}`,
			);
			await ctx.db.patch(rawEventId, { processed: true });
			return;
		}
		console.log(
			`[Pipeline:invitee.created] No duplicate meeting found, proceeding`,
		);

		const now = Date.now();
		const durationMinutes = Math.max(
			1,
			Math.round((endTime - scheduledAt) / 60000),
		);
		const bookingQuestionsAndAnswers = extractQuestionsAndAnswers(
			payload.questions_and_answers,
		);
		const latestCustomFields = toQuestionAnswerRecord(
			bookingQuestionsAndAnswers,
		);
		const utmParams = extractUtmParams(payload.tracking);
		const eventTypeConfigLookup = await lookupEventTypeConfig(ctx, {
			tenantId,
			eventTypeUri,
		});
		const earlyEventTypeConfig = eventTypeConfigLookup.existingConfig;
		const extractedIdentifiers = extractIdentifiersFromCustomFields(
			latestCustomFields,
			earlyEventTypeConfig,
		);
		const effectivePhone =
			extractedIdentifiers.phoneOverride ?? inviteePhone;
		console.log(
			`[Pipeline:invitee.created] UTM extraction | hasUtm=${!!utmParams} source=${utmParams?.utm_source ?? "none"} medium=${utmParams?.utm_medium ?? "none"} campaign=${utmParams?.utm_campaign ?? "none"}`,
		);

		if (utmParams?.utm_source === "ptdom" && utmParams.utm_campaign) {
			console.log(
				`[Pipeline:invitee.created] [Feature A] UTM deterministic linking | opportunityId=${utmParams.utm_campaign} medium=${utmParams.utm_medium ?? "none"} content=${utmParams.utm_content ?? "none"}`,
			);

			const targetOpportunityId =
				utmParams.utm_campaign as Id<"opportunities">;
			const isNoShowRescheduleUtm =
				utmParams.utm_medium === "noshow_resched";
			const targetFollowUpId =
				!isNoShowRescheduleUtm && utmParams.utm_content
					? (utmParams.utm_content as Id<"followUps">)
					: undefined;
			const targetOpportunity = await ctx.db.get(targetOpportunityId);

			if (
				targetOpportunity &&
				targetOpportunity.tenantId === tenantId &&
				(targetOpportunity.status === "follow_up_scheduled" ||
					targetOpportunity.status === "reschedule_link_sent") &&
				validateTransition(targetOpportunity.status, "scheduled")
			) {
				const previousTargetStatus = targetOpportunity.status;
				const targetLead = await ctx.db.get(targetOpportunity.leadId);
				if (!targetLead || targetLead.tenantId !== tenantId) {
					console.warn(
						`[Pipeline:invitee.created] [Feature A] Opportunity lead missing or invalid | opportunityId=${targetOpportunityId} leadId=${targetOpportunity.leadId}`,
					);
				} else {
					const lead = await syncLeadFromBooking(ctx, targetLead, {
						inviteeName,
						inviteePhone: effectivePhone,
						latestCustomFields,
						now,
					});
					await updateLeadSearchText(ctx, lead._id);
					const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
						extractHostMembership(scheduledEvent);
					const assignedCloserId = await resolveAssignedCloserId(
						ctx,
						tenantId,
						hostUserUri,
					);
					console.log(
						`[Pipeline:invitee.created] Assigned closer resolved | closerId=${assignedCloserId ?? "none"} hostEmail=${hostCalendlyEmail ?? "none"}`,
					);
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
						throw new Error(
							"[Pipeline] Unable to resolve assigned closer for deterministic booking",
						);
					}

					await ctx.db.patch(targetOpportunityId, {
						status: "scheduled",
						calendlyEventUri,
						assignedCloserId: nextAssignedCloserId,
						hostCalendlyUserUri: hostUserUri,
						hostCalendlyEmail,
						hostCalendlyName,
						eventTypeConfigId: effectiveEventTypeConfigId,
						updatedAt: now,
					});
					await replaceOpportunityAggregate(
						ctx,
						targetOpportunity,
						targetOpportunityId,
					);
					if (closerChanged) {
						await syncOpportunityMeetingsAssignedCloser(
							ctx,
							targetOpportunityId,
							nextAssignedCloserId,
						);
					}
					await emitDomainEvent(ctx, {
						tenantId,
						entityType: "opportunity",
						entityId: targetOpportunityId,
						eventType: "opportunity.status_changed",
						source: "pipeline",
						fromStatus: previousTargetStatus,
						toStatus: "scheduled",
						occurredAt: now,
					});
					console.log(
						`[Pipeline:invitee.created] [Feature A] Opportunity relinked | opportunityId=${targetOpportunityId} status=${previousTargetStatus}->scheduled`,
					);

					let rescheduledFromMeetingId: Id<"meetings"> | undefined;
					if (isNoShowRescheduleUtm && utmParams.utm_content) {
						const candidateMeetingId =
							utmParams.utm_content as Id<"meetings">;
						const originalMeeting = await ctx.db.get(
							candidateMeetingId,
						);
						if (originalMeeting && originalMeeting.tenantId === tenantId) {
							rescheduledFromMeetingId = originalMeeting._id;
						} else {
							console.warn(
								`[Pipeline:invitee.created] [Feature B] Invalid no-show reschedule meeting | meetingId=${candidateMeetingId}`,
							);
						}
					}

					if (targetFollowUpId) {
						const followUp = await ctx.db.get(targetFollowUpId);
						if (
							followUp &&
							followUp.tenantId === tenantId &&
							followUp.status === "pending" &&
							followUp.opportunityId === targetOpportunityId &&
							followUp.type !== "manual_reminder"
						) {
							const bookedAt = Date.now();
							await ctx.db.patch(targetFollowUpId, {
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
							console.log(
								`[Pipeline:invitee.created] [Feature A] Follow-up marked booked | followUpId=${targetFollowUpId}`,
							);
						} else {
							console.warn(
								`[Pipeline:invitee.created] [Feature A] Follow-up target invalid | followUpId=${targetFollowUpId}`,
							);
						}
					} else {
						await ctx.runMutation(
							internal.closer.followUpMutations
								.markFollowUpBooked,
							{
								opportunityId: targetOpportunityId,
								calendlyEventUri,
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
						rescheduledFromMeetingId,
					});
					await insertMeetingAggregate(ctx, meetingId);
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

					if (rescheduledFromMeetingId) {
						console.log(
							`[Pipeline:invitee.created] [Feature B] Reschedule chain linked | newMeetingId=${meetingId} rescheduledFrom=${rescheduledFromMeetingId}`,
						);
					}

					await updateOpportunityMeetingRefs(
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

					await ctx.db.patch(rawEventId, { processed: true });
					console.log(
						`[Pipeline:invitee.created] [Feature A] Deterministic linking complete | meetingId=${meetingId} opportunityId=${targetOpportunityId}`,
					);
					return;
				}
			}

			console.warn(
				`[Pipeline:invitee.created] [Feature A] UTM target invalid | opportunityExists=${!!targetOpportunity} tenantMatch=${targetOpportunity?.tenantId === tenantId} status=${targetOpportunity?.status ?? "N/A"} - falling through to normal flow`,
			);
		}

		// === Feature E: Multi-identifier identity resolution ===
		const resolution = await resolveLeadIdentity(
			ctx,
			tenantId,
			inviteeEmail,
			inviteeName,
			effectivePhone,
			extractedIdentifiers.socialHandle,
			now,
		);

		let lead = resolution.lead;
		console.log(
			`[Pipeline:Identity] Resolution complete | leadId=${lead._id} isNew=${resolution.isNewLead} via=${resolution.resolvedVia} potentialDuplicate=${resolution.potentialDuplicateLeadId ?? "none"}`,
		);

		// If existing lead, update fields (existing behavior, preserved)
		if (!resolution.isNewLead) {
			lead = await syncLeadFromBooking(ctx, lead, {
				inviteeName,
				inviteePhone: effectivePhone,
				latestCustomFields,
				now,
			});
			await updateLeadSearchText(ctx, lead._id);
		} else if (latestCustomFields) {
			// New lead: set custom fields (they were not set in resolveLeadIdentity)
			await ctx.db.patch(lead._id, {
				customFields: latestCustomFields,
			});
			await syncCustomerSnapshot(ctx, tenantId, lead._id);
		}
		// === End Feature E: Identity Resolution ===

		const { hostUserUri, hostCalendlyEmail, hostCalendlyName } =
			extractHostMembership(scheduledEvent);
		const assignedCloserId = await resolveAssignedCloserId(
			ctx,
			tenantId,
			hostUserUri,
		);
		console.log(
			`[Pipeline:invitee.created] Assigned closer resolved | closerId=${assignedCloserId ?? "none"} hostEmail=${hostCalendlyEmail ?? "none"}`,
		);
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
		const reschedCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");

		for await (const opportunity of reschedCandidates) {
			if (
				(opportunity.status === "no_show" ||
					opportunity.status === "canceled") &&
				opportunity.updatedAt > rescheduleCutoff
			) {
				autoRescheduleTarget = opportunity;
				break;
			}
		}

		if (autoRescheduleTarget) {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule detected | opportunityId=${autoRescheduleTarget._id} status=${autoRescheduleTarget.status}`,
			);

			if (!validateTransition(autoRescheduleTarget.status, "scheduled")) {
				console.warn(
					`[Pipeline:invitee.created] [Feature B4] Invalid transition ${autoRescheduleTarget.status} -> scheduled | falling through to normal flow`,
				);
				autoRescheduleTarget = null;
			}
		} else {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] No reschedule candidate found for leadId=${lead._id} | proceeding to follow-up detection`,
			);
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
			const rescheduledFromMeetingId = previousMeetings[0]?._id;
			const nextAssignedCloserId =
				assignedCloserId ?? autoRescheduleTarget.assignedCloserId;
			const effectiveEventTypeConfigId =
				eventTypeConfigId ??
				autoRescheduleTarget.eventTypeConfigId ??
				undefined;
			const closerChanged =
				nextAssignedCloserId !== autoRescheduleTarget.assignedCloserId;
			if (!nextAssignedCloserId) {
				throw new Error(
					"[Pipeline] Unable to resolve assigned closer for auto-rescheduled booking",
				);
			}

			await ctx.db.patch(reschedOpportunityId, {
				status: "scheduled",
				calendlyEventUri,
				assignedCloserId: nextAssignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId: effectiveEventTypeConfigId,
				updatedAt: now,
			});
			await replaceOpportunityAggregate(
				ctx,
				autoRescheduleTarget,
				reschedOpportunityId,
			);
			if (closerChanged) {
				await syncOpportunityMeetingsAssignedCloser(
					ctx,
					reschedOpportunityId,
					nextAssignedCloserId,
				);
			}
			await updateTenantStats(ctx, tenantId, {
				activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
					? 0
					: 1,
			});
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "opportunity",
				entityId: reschedOpportunityId,
				eventType: "opportunity.status_changed",
				source: "pipeline",
				fromStatus: previousOpportunityStatus,
				toStatus: "scheduled",
				occurredAt: now,
			});
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Opportunity relinked | opportunityId=${reschedOpportunityId} status=${previousOpportunityStatus}->scheduled`,
			);

			if (closerChanged) {
				console.log(
					`[Pipeline:invitee.created] [Feature B4] Opportunity reassigned | opportunityId=${reschedOpportunityId} from=${autoRescheduleTarget.assignedCloserId ?? "none"} to=${nextAssignedCloserId ?? "none"}`,
				);
			}

			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId: reschedOpportunityId,
					calendlyEventUri,
				},
			);

			const meetingLocation = extractMeetingLocation(scheduledEvent.location);
			const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");
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
				rescheduledFromMeetingId,
			});
			await insertMeetingAggregate(ctx, meetingId);
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
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Meeting created | meetingId=${meetingId} rescheduledFrom=${rescheduledFromMeetingId ?? "none"}`,
			);

			await updateOpportunityMeetingRefs(ctx, reschedOpportunityId);
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
			await syncKnownCustomFieldKeys(
				ctx,
				effectiveEventTypeConfigId,
				latestCustomFields,
			);

			await ctx.db.patch(rawEventId, { processed: true });
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule complete | meetingId=${meetingId} opportunityId=${reschedOpportunityId}`,
			);
			return;
		}
		// === End Feature B4: Opportunity linking + closer reassignment ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
		const followUpCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");
		for await (const opportunity of followUpCandidates) {
			if (opportunity.status === "follow_up_scheduled") {
				existingFollowUp = opportunity;
				break;
			}
		}

		if (existingFollowUp) {
			console.log(
				`[Pipeline:invitee.created] Follow-up opportunity detected | opportunityId=${existingFollowUp._id}`,
			);
		} else {
			console.log(
				`[Pipeline:invitee.created] No follow-up opportunity found, creating new`,
			);
		}

		const meetingAssignedCloserId = existingFollowUp
			? assignedCloserId ?? existingFollowUp.assignedCloserId
			: assignedCloserId;
		if (!meetingAssignedCloserId) {
			throw new Error(
				"[Pipeline] Unable to resolve assigned closer for invitee.created",
			);
		}

		let opportunityId: Id<"opportunities">;
		let meetingEventTypeConfigId: Id<"eventTypeConfigs"> | undefined =
			eventTypeConfigId;
		if (existingFollowUp) {
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
			await ctx.db.patch(opportunityId, {
				status: "scheduled",
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
			});
			await replaceOpportunityAggregate(
				ctx,
				existingFollowUp,
				opportunityId,
			);
			if (closerChanged) {
				await syncOpportunityMeetingsAssignedCloser(
					ctx,
					opportunityId,
					nextAssignedCloserId,
				);
			}
			await emitDomainEvent(ctx, {
				tenantId,
				entityType: "opportunity",
				entityId: opportunityId,
				eventType: "opportunity.status_changed",
				source: "pipeline",
				fromStatus: existingFollowUp.status,
				toStatus: "scheduled",
				occurredAt: now,
			});
			console.log(
				`[Pipeline:invitee.created] Follow-up opportunity reused | opportunityId=${opportunityId} status=follow_up_scheduled->scheduled`,
			);

			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId,
					calendlyEventUri,
				},
			);
		} else {
			opportunityId = await ctx.db.insert("opportunities", {
				tenantId,
				leadId: lead._id,
				assignedCloserId: meetingAssignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId,
				status: "scheduled",
				calendlyEventUri,
				createdAt: now,
				updatedAt: now,
				utmParams,
				potentialDuplicateLeadId: resolution.potentialDuplicateLeadId,
			});
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
			console.log(
				`[Pipeline:invitee.created] New opportunity created | opportunityId=${opportunityId}`,
			);
		}

		const meetingLocation = extractMeetingLocation(scheduledEvent.location);
		const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");

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
		});
		await insertMeetingAggregate(ctx, meetingId);
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
		console.log(
			`[Pipeline:invitee.created] Meeting created | meetingId=${meetingId} durationMinutes=${durationMinutes}`,
		);

		// Update denormalized meeting refs on opportunity for efficient queries
		// (see @plans/caching/caching.md)
		await updateOpportunityMeetingRefs(ctx, opportunityId);
		console.log(
			`[Pipeline:invitee.created] Updated opportunity meeting refs | opportunityId=${opportunityId}`,
		);

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
		console.log(
			`[Pipeline:Identity] Lead identifiers created | leadId=${lead._id} meetingId=${meetingId}`,
		);
		await updateLeadSearchText(ctx, lead._id);
		// === End Feature E ===

		await syncKnownCustomFieldKeys(
			ctx,
			meetingEventTypeConfigId,
			latestCustomFields,
		);

		await ctx.db.patch(rawEventId, { processed: true });
		console.log(
			`[Pipeline:invitee.created] Marked processed | rawEventId=${rawEventId}`,
		);
	},
});
