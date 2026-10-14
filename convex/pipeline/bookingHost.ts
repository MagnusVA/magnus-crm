import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getString, isRecord } from "../lib/payloadExtraction";
import { blockBooking } from "./blocked";

/**
 * Who hosts a Calendly booking, and what the pipeline does about it. The
 * invitee.created handler and the follow-up events (reschedule creates,
 * cancellations, no-shows) of a booking without a meeting share these rules,
 * so a change to how a host is treated applies to all of them.
 */

export type AssignedCloserResolution = {
	assignedCloserId: Id<"users"> | undefined;
	hostCalendlyRole: string | undefined;
	isKnownNonCloserHost: boolean;
	resolution:
		| "missing_host"
		| "direct_closer"
		| "direct_non_closer"
		| "org_member_closer"
		| "org_member_non_closer"
		| "org_member_unmatched"
		| "unknown_host";
};

export function extractHostMembership(scheduledEvent: Record<string, unknown>) {
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

export async function resolveAssignedCloser(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	hostUserUri: string | undefined,
): Promise<AssignedCloserResolution> {

	if (!hostUserUri) {
		return {
			assignedCloserId: undefined,
			hostCalendlyRole: undefined,
			isKnownNonCloserHost: false,
			resolution: "missing_host",
		};
	}

	const directUser = await ctx.db
		.query("users")
		.withIndex("by_tenantId_and_calendlyUserUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
		)
		.unique();
	if (directUser?.role === "closer") {
    if (!directUser.isActive) blockBooking("host_inactive");
		return {
			assignedCloserId: directUser._id,
			hostCalendlyRole: undefined,
			isKnownNonCloserHost: false,
			resolution: "direct_closer",
		};
	}

	if (directUser) {
		return {
			assignedCloserId: undefined,
			hostCalendlyRole: undefined,
			isKnownNonCloserHost: true,
			resolution: "direct_non_closer",
		};
	}

	const orgMember = await ctx.db
		.query("calendlyOrgMembers")
		.withIndex("by_tenantId_and_calendlyUserUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
		)
		.unique();
	if (orgMember?.matchedUserId) {
		const matchedUser = await ctx.db.get("users", orgMember.matchedUserId);
		if (matchedUser && matchedUser.tenantId !== tenantId) blockBooking("host_not_linked");
		if (matchedUser?.role === "closer") {
      if (!matchedUser.isActive) blockBooking("host_inactive");
			return {
				assignedCloserId: matchedUser._id,
				hostCalendlyRole: orgMember.calendlyRole,
				isKnownNonCloserHost: false,
				resolution: "org_member_closer",
			};
		}

		if (matchedUser) {
			return {
				assignedCloserId: undefined,
				hostCalendlyRole: orgMember.calendlyRole,
				isKnownNonCloserHost: true,
				resolution: "org_member_non_closer",
			};
		}
	}

	if (orgMember) {
		return {
			assignedCloserId: undefined,
			hostCalendlyRole: orgMember.calendlyRole,
			isKnownNonCloserHost: true,
			resolution: "org_member_unmatched",
		};
	}

	return {
		assignedCloserId: undefined,
		hostCalendlyRole: undefined,
		isKnownNonCloserHost: false,
		resolution: "unknown_host",
	};
}

/**
 * What a booking without an opportunity to fall back on gets from its host:
 * - `closer`: the pipeline tracks it.
 * - `ignored`: a host known not to be a closer. Routine, nothing to review.
 * - `blocked`: a host the CRM can't place (a Calendly member not linked to a
 *   CRM user, or no known host). Often an unlinked closer, so it's held for
 *   review.
 */
export type BookingHostOutcome =
	| { status: "closer"; assignedCloserId: Id<"users"> }
	| { status: "ignored"; reason: "non_closer_host" }
	| { status: "blocked"; reason: "host_not_linked" };

export function bookingHostOutcome(
	resolution: AssignedCloserResolution,
): BookingHostOutcome {
	if (resolution.assignedCloserId)
		return { status: "closer", assignedCloserId: resolution.assignedCloserId };
	if (
		resolution.isKnownNonCloserHost &&
		resolution.resolution !== "org_member_unmatched"
	)
		return { status: "ignored", reason: "non_closer_host" };
	return { status: "blocked", reason: "host_not_linked" };
}

/** Resolves and classifies the host of a Calendly invitee payload. Throws a
 * booking block where host resolution does (an inactive closer, a cross-tenant
 * link). */
export async function classifyBookingHost(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	payload: unknown,
) {
	const scheduledEvent =
		isRecord(payload) && isRecord(payload.scheduled_event)
			? payload.scheduled_event
			: {};
	const resolution = await resolveAssignedCloser(
		ctx,
		tenantId,
		extractHostMembership(scheduledEvent).hostUserUri,
	);
	return { resolution, outcome: bookingHostOutcome(resolution) };
}
