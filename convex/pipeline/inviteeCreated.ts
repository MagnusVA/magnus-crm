import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";
import { extractUtmParams } from "../lib/utmParams";
import { extractMeetingLocation } from "../lib/meetingLocation";
import { isRecord, getString } from "../lib/payloadExtraction";
import {
	normalizeEmail,
	normalizeSocialHandle,
	normalizePhone,
	areNamesSimilar,
	extractEmailDomain,
} from "../lib/normalization";
import type { IdentifierType, SocialPlatformType } from "../lib/normalization";

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function extractQuestionsAndAnswers(
	value: unknown,
): Record<string, string> | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}

	const result: Record<string, string> = {};
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}

		const question = getString(item, "question");
		const answer = getString(item, "answer");
		if (question && answer) {
			result[question] = answer;
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
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
		const latestCustomFields = extractQuestionsAndAnswers(
			payload.questions_and_answers,
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
				`[Pipeline:invitee.created] [Feature A] UTM deterministic linking | opportunityId=${utmParams.utm_campaign} followUpId=${utmParams.utm_content ?? "none"}`,
			);

			const targetOpportunityId =
				utmParams.utm_campaign as Id<"opportunities">;
			const targetFollowUpId = utmParams.utm_content
				? (utmParams.utm_content as Id<"followUps">)
				: undefined;
			const targetOpportunity = await ctx.db.get(targetOpportunityId);

			if (
				targetOpportunity &&
				targetOpportunity.tenantId === tenantId &&
				targetOpportunity.status === "follow_up_scheduled" &&
				validateTransition(targetOpportunity.status, "scheduled")
			) {
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

					await ctx.db.patch(targetOpportunityId, {
						status: "scheduled",
						calendlyEventUri,
						assignedCloserId:
							assignedCloserId ??
							targetOpportunity.assignedCloserId,
						hostCalendlyUserUri: hostUserUri,
						hostCalendlyEmail,
						hostCalendlyName,
						eventTypeConfigId:
							eventTypeConfigId ??
							targetOpportunity.eventTypeConfigId ??
							undefined,
						updatedAt: now,
					});
					console.log(
						`[Pipeline:invitee.created] [Feature A] Opportunity relinked | opportunityId=${targetOpportunityId} status=follow_up_scheduled->scheduled`,
					);

					if (targetFollowUpId) {
						const followUp = await ctx.db.get(targetFollowUpId);
						if (
							followUp &&
							followUp.tenantId === tenantId &&
							followUp.status === "pending" &&
							followUp.opportunityId === targetOpportunityId &&
							followUp.type !== "manual_reminder"
						) {
							await ctx.db.patch(targetFollowUpId, {
								status: "booked",
								calendlyEventUri,
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
						calendlyEventUri,
						calendlyInviteeUri,
						zoomJoinUrl: meetingLocation.zoomJoinUrl,
						meetingJoinUrl: meetingLocation.meetingJoinUrl,
						meetingLocationType:
							meetingLocation.meetingLocationType,
						scheduledAt,
						durationMinutes,
						status: "scheduled",
						notes: meetingNotes,
						leadName: lead.fullName ?? lead.email,
						createdAt: now,
						utmParams,
					});

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
					await syncKnownCustomFieldKeys(
						ctx,
						eventTypeConfigId,
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
		} else if (latestCustomFields) {
			// New lead: set custom fields (they were not set in resolveLeadIdentity)
			await ctx.db.patch(lead._id, {
				customFields: latestCustomFields,
			});
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

		let opportunityId: Id<"opportunities">;
		if (existingFollowUp) {
			if (!validateTransition(existingFollowUp.status, "scheduled")) {
				throw new Error(
					"[Pipeline] Invalid follow-up opportunity transition",
				);
			}

			opportunityId = existingFollowUp._id;
			await ctx.db.patch(opportunityId, {
				status: "scheduled",
				calendlyEventUri,
				assignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId:
					eventTypeConfigId ??
					existingFollowUp.eventTypeConfigId ??
					undefined,
				updatedAt: now,
				// NOTE: utmParams intentionally NOT included here.
				// The opportunity preserves attribution from its original creation.
				// The new meeting stores its own UTMs independently.
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
				assignedCloserId,
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
			console.log(
				`[Pipeline:invitee.created] New opportunity created | opportunityId=${opportunityId}`,
			);
		}

		const meetingLocation = extractMeetingLocation(scheduledEvent.location);
		const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");

		const meetingId = await ctx.db.insert("meetings", {
			tenantId,
			opportunityId,
			calendlyEventUri,
			calendlyInviteeUri,
			zoomJoinUrl: meetingLocation.zoomJoinUrl,
			meetingJoinUrl: meetingLocation.meetingJoinUrl,
			meetingLocationType: meetingLocation.meetingLocationType,
			scheduledAt,
			durationMinutes,
			status: "scheduled",
			notes: meetingNotes,
			leadName: lead.fullName ?? lead.email, // Denormalize for query efficiency
			createdAt: now,
			utmParams,
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
		// === End Feature E ===

		await syncKnownCustomFieldKeys(
			ctx,
			eventTypeConfigId,
			latestCustomFields,
		);

		await ctx.db.patch(rawEventId, { processed: true });
		console.log(
			`[Pipeline:invitee.created] Marked processed | rawEventId=${rawEventId}`,
		);
	},
});
