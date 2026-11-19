import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isInternalUtm } from "../lib/attribution/resolveAttribution";
import { isLinkCode, normalizeLinkCode, readsProgramFromLink } from "../lib/closerLinks";
import { log } from "../lib/observability/log";
import type { extractUtmParams } from "../lib/utmParams";

type UtmParams = ReturnType<typeof extractUtmParams>;

/** The program fields a booking writes onto its meeting (and its deal's first-booking cache). */
export type BookedProgram = {
	bookingProgramId: Id<"tenantPrograms"> | undefined;
	bookingProgramName: string | undefined;
	bookingProgramMappingStatus: "mapped" | "unmapped";
};

/** The event type's own program: what every booking recorded before closer links. */
export function bookedProgramPatch(
	config: Doc<"eventTypeConfigs"> | null | undefined,
): BookedProgram {
	return {
		bookingProgramId: config?.bookingProgramId,
		bookingProgramName: config?.bookingProgramName,
		bookingProgramMappingStatus:
			config?.bookingProgramMappingStatus ?? ("unmapped" as const),
	};
}

/** Longer than any code plus stray spaces: rejected before normalizing. */
const MAX_CODE_INPUT_LENGTH = 64;

/**
 * A booking's program. In order:
 * 1. The effective event type's fixed program, exactly as before. The
 *    effective config can be the deal's when the payload names no event type.
 * 2. A closer link: the booked event type itself reads program codes, the
 *    link is not one of the CRM's own (`ptdom`), and `utm_content` is the
 *    current code of exactly one active program in the tenant.
 * 3. A Calendly reschedule of a closer-link booking whose tracking has no
 *    usable code keeps the replaced meeting's program.
 * 4. Otherwise the effective event type's mapping (unmapped).
 * Never throws on what a lead put in the link.
 */
export async function resolveBookedProgram(
	ctx: MutationCtx,
	args: {
		tenantId: Id<"tenants">;
		incomingConfig: Doc<"eventTypeConfigs"> | null | undefined;
		effectiveConfig: Doc<"eventTypeConfigs"> | null | undefined;
		utmParams: UtmParams;
		replacedMeeting?: Doc<"meetings"> | null;
		/** The replaced meeting's deal's event type, for a reschedule that names none. */
		replacedMeetingConfig?: Doc<"eventTypeConfigs"> | null;
	},
): Promise<BookedProgram> {
	const { tenantId, incomingConfig, effectiveConfig, utmParams, replacedMeeting } = args;
	if (effectiveConfig?.bookingProgramId !== undefined) {
		return bookedProgramPatch(effectiveConfig);
	}
	if (isInternalUtm(utmParams)) return bookedProgramPatch(effectiveConfig);

	// Only the booked event type itself can read a code. A reschedule whose
	// payload names no event type falls back to the deal's config, which may
	// only let it keep the replaced meeting's program.
	const linkConfig =
		incomingConfig ??
		(replacedMeeting ? (effectiveConfig ?? args.replacedMeetingConfig ?? null) : null);
	if (!linkConfig || linkConfig.programFromLinkAt === undefined) {
		return bookedProgramPatch(effectiveConfig);
	}
	const rawCode = utmParams?.utm_content;

	// A Calendly reschedule of a closer-link booking keeps the program it was
	// booked for, whatever its tracking says now.
	if (
		replacedMeeting &&
		replacedMeeting.tenantId === tenantId &&
		replacedMeeting.bookingProgramMappingStatus === "mapped" &&
		replacedMeeting.bookingProgramId !== undefined
	) {
		log.info("pipeline.closer_link_program.inherited", {
			tenantId,
			eventTypeConfigId: linkConfig._id,
			replacedMeetingId: replacedMeeting._id,
			hadCode: rawCode !== undefined,
		});
		return {
			bookingProgramId: replacedMeeting.bookingProgramId,
			bookingProgramName: replacedMeeting.bookingProgramName,
			bookingProgramMappingStatus: "mapped",
		};
	}

	// The raw value is the lead's to edit, so only its length is logged.
	const wellFormed = rawCode !== undefined && isLinkCode(normalizeLinkCode(rawCode));
	if (!readsProgramFromLink(linkConfig)) return bookedProgramPatch(effectiveConfig);
	const fromCode =
		incomingConfig && rawCode ? await programForLinkCode(ctx, tenantId, rawCode) : null;
	if (fromCode) return fromCode;

	log.warn("pipeline.closer_link_program.unresolved", {
		tenantId,
		eventTypeConfigId: linkConfig._id,
		reason: rawCode === undefined ? "missing_code" : wellFormed ? "unknown_code" : "malformed_code",
		codeLength: rawCode?.length,
	});
	return bookedProgramPatch(effectiveConfig);
}

async function programForLinkCode(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	rawCode: string,
): Promise<BookedProgram | null> {
	if (rawCode.length > MAX_CODE_INPUT_LENGTH) return null;
	const code = normalizeLinkCode(rawCode);
	if (!isLinkCode(code)) return null;
	const matches = await ctx.db
		.query("tenantPrograms")
		.withIndex("by_tenantId_and_linkCode", (q) =>
			q.eq("tenantId", tenantId).eq("linkCode", code),
		)
		.take(2);
	if (matches.length !== 1) {
		if (matches.length > 1) {
			log.warn("pipeline.closer_link_program.duplicate_code", { tenantId, code });
		}
		return null;
	}
	const [program] = matches;
	if (!program || program.archivedAt !== undefined) return null;
	return {
		bookingProgramId: program._id,
		bookingProgramName: program.name,
		bookingProgramMappingStatus: "mapped",
	};
}
