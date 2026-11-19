// Booking > Closer links: each active phone closer's personal Calendly link,
// whether it is in the DM portal, and the programs' link codes.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { isCalendlyBookable } from "../lib/bookingSetup/coverage";
import {
	CLOSER_LINK_STATUS_LABEL,
	bookingUrlKey,
	calendarStatus,
	closerCalendarUrl,
	isSoloCalendar,
	type CloserLinkStatus,
} from "../lib/closerLinks";
import {
	listActivePhoneClosers,
	listOwnedEventTypeConfigs,
	lookupCanonicalEventTypeConfig,
	readCloserLinkState,
} from "../lib/closerLinkData";
import { userMemberIdentity } from "../lib/memberIdentity";
import { log } from "../lib/observability/log";
import { rejectRequest } from "../lib/observability/errors";
import { isActiveLogin } from "../lib/teamMembers";
import { requireTenantUser } from "../requireTenantUser";
import { listProgramsForTenant, sortProgramsForDisplay } from "../tenantPrograms/shared";

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;

function calendarOption(config: Doc<"eventTypeConfigs">) {
	return {
		eventTypeConfigId: config._id,
		displayName: config.displayName,
		url: closerCalendarUrl(config) ?? null,
		durationMinutes: config.calendlyDurationMinutes ?? null,
		status: calendarStatus(config),
	};
}

/** Each closer's own one-on-one event types, one per Calendly event type (its canonical config). */
function calendarOptions(owned: Array<Doc<"eventTypeConfigs">>) {
	const byUri = new Map<string, Doc<"eventTypeConfigs">>();
	for (const config of owned) {
		if (!isSoloCalendar(config) || config.calendlySyncStatus === "deleted") continue;
		const current = byUri.get(config.calendlyEventTypeUri);
		if (!current || config.createdAt < current.createdAt) byUri.set(config.calendlyEventTypeUri, config);
	}
	return [...byUri.values()]
		.map(calendarOption)
		.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export const listCloserLinks = query({
	args: {},
	handler: async (ctx) => {
		const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
		const [closers, programs] = await Promise.all([
			listActivePhoneClosers(ctx, tenantId),
			listProgramsForTenant(ctx, tenantId),
		]);

		const rows = await Promise.all(
			closers.map(async (user) => {
				const state = await readCloserLinkState(ctx, user);
				return {
					userId: user._id,
					name: user.fullName?.trim() || user.email,
					avatar: await userMemberIdentity(ctx, user),
					calendlyLinked: user.calendlyUserUri !== undefined,
					personalEventTypeUri: user.personalEventTypeUri ?? null,
					inPortal: user.closerLinkInPortalAt !== undefined,
					status: state.status,
					statusLabel: CLOSER_LINK_STATUS_LABEL[state.status],
					linkEventTypeConfigId: state.config?._id ?? null,
					options: calendarOptions(state.owned),
				};
			}),
		);

		return {
			closers: rows.sort((left, right) => left.name.localeCompare(right.name)),
			programs: sortProgramsForDisplay(programs)
				.filter((program) => program.archivedAt === undefined)
				.map((program) => ({
					programId: program._id,
					name: program.name,
					linkCode: program.linkCode ?? null,
				})),
		};
	},
});

async function loadActiveCloser(ctx: MutationCtx, tenantId: Id<"tenants">, userId: Id<"users">) {
	const user = await ctx.db.get("users", userId);
	if (!user || user.tenantId !== tenantId) {
		throw rejectRequest("closer_links.not_found", "Closer not found.", { tenantId });
	}
	if (user.role !== "closer") {
		throw rejectRequest("closer_links.not_closer", "Only phone closers have closer links.", { tenantId, userId });
	}
	if (!isActiveLogin(user)) {
		throw rejectRequest("closer_links.deactivated", "This closer is deactivated.", { tenantId, userId });
	}
	return user;
}

async function isInCoverageCell(ctx: MutationCtx, tenantId: Id<"tenants">, eventTypeConfigId: Id<"eventTypeConfigs">) {
	const [teamRoute, sharedRoute] = await Promise.all([
		ctx.db
			.query("teamProgramEventTypes")
			.withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
				q.eq("tenantId", tenantId).eq("eventTypeConfigId", eventTypeConfigId),
			)
			.first(),
		ctx.db
			.query("sharedProgramEventTypes")
			.withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
				q.eq("tenantId", tenantId).eq("eventTypeConfigId", eventTypeConfigId),
			)
			.first(),
	]);
	return teamRoute !== null || sharedRoute !== null;
}

const SETTABLE_STATUSES: ReadonlySet<CloserLinkStatus> = new Set(["ready", "program_from_link_off"]);

/**
 * Sets a closer's personal link: one of their own one-on-one Calendly event
 * types, picked or pasted. The link also serves their follow-up and no-show
 * reschedule links. Turns on "program from link" for that event type; an
 * event type the closer used before keeps it, so links already sent resolve.
 */
export const setCloserLink = mutation({
	args: {
		userId: v.id("users"),
		eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
		url: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
		const user = await loadActiveCloser(ctx, tenantId, args.userId);
		if ((args.eventTypeConfigId === undefined) === (args.url === undefined)) {
			throw rejectRequest("closer_links.invalid", "Pick an event type or paste a link.", { tenantId });
		}

		// A picked event type must be one the closer can use for closer links.
		// A pasted link is always saved (it is also their follow-up and no-show
		// reschedule link), and becomes a closer link only when it is one.
		let config: Doc<"eventTypeConfigs"> | null = null;
		let url: string;
		if (args.eventTypeConfigId !== undefined) {
			const picked = await ctx.db.get("eventTypeConfigs", args.eventTypeConfigId);
			if (
				!picked ||
				picked.tenantId !== tenantId ||
				!user.calendlyUserUri ||
				picked.calendlyOwnerUri !== user.calendlyUserUri
			) {
				throw rejectRequest(
					"closer_links.not_their_calendar",
					"That event type isn't one of this closer's in Calendly.",
					{ tenantId, userId: user._id },
				);
			}
			const usable = await usableCalendar(ctx, tenantId, user, picked.calendlyEventTypeUri);
			if (typeof usable === "string") {
				throw rejectRequest("closer_links.calendar_unusable", usable, {
					tenantId,
					userId: user._id,
					eventTypeConfigId: picked._id,
				});
			}
			// Readiness matches the personal link by URL, so it must name one event type.
			const owned = await listOwnedEventTypeConfigs(ctx, tenantId, user.calendlyUserUri);
			const key = bookingUrlKey(closerCalendarUrl(usable));
			const sameUrl = new Set(
				owned
					.filter((row) => isCalendlyBookable(row) && bookingUrlKey(closerCalendarUrl(row)) === key)
					.map((row) => row.calendlyEventTypeUri),
			);
			if (key === null || sameUrl.size !== 1) {
				throw rejectRequest("closer_links.ambiguous", `${CLOSER_LINK_STATUS_LABEL.ambiguous}.`, {
					tenantId,
					userId: user._id,
					matches: sameUrl.size,
				});
			}
			config = usable;
			url = closerCalendarUrl(usable) ?? "";
		} else {
			const pasted = args.url?.trim() ?? "";
			const key = bookingUrlKey(pasted);
			if (key === null || !isCalendlyHost(new URL(pasted).hostname)) {
				throw rejectRequest("closer_links.invalid_url", "Paste a full Calendly link.", { tenantId });
			}
			url = pasted;
			const owned = await listOwnedEventTypeConfigs(ctx, tenantId, user.calendlyUserUri);
			const uris = new Set(
				owned
					.filter((row) => isCalendlyBookable(row) && bookingUrlKey(closerCalendarUrl(row)) === key)
					.map((row) => row.calendlyEventTypeUri),
			);
			const [uri] = [...uris];
			if (uris.size === 1 && uri) {
				const match = await usableCalendar(ctx, tenantId, user, uri);
				if (typeof match !== "string") {
					config = match;
					url = closerCalendarUrl(match) ?? pasted;
				}
			}
		}
		if (!url) {
			throw rejectRequest("closer_links.missing_url", "That event type has no booking URL.", { tenantId });
		}

		const now = Date.now();
		const previousPersonalEventTypeUri = user.personalEventTypeUri ?? null;
		await ctx.db.patch("users", user._id, { personalEventTypeUri: url });
		if (config && config.programFromLinkAt === undefined) {
			await ctx.db.patch("eventTypeConfigs", config._id, { programFromLinkAt: now, updatedAt: now });
		}
		const state = await readCloserLinkState(ctx, { ...user, personalEventTypeUri: url });
		log.info("closer_link.set", {
			tenantId,
			userId: user._id,
			eventTypeConfigId: config?._id,
			replacedExisting: previousPersonalEventTypeUri !== null,
			source: args.url !== undefined ? "pasted" : "picked",
			status: state.status,
		});
		return {
			previousPersonalEventTypeUri,
			status: state.status,
			statusLabel: CLOSER_LINK_STATUS_LABEL[state.status],
		};
	},
});

/**
 * The canonical config of one of the closer's event types if closer links can
 * use it, else why not.
 */
async function usableCalendar(
	ctx: MutationCtx,
	tenantId: Id<"tenants">,
	user: Doc<"users">,
	calendlyEventTypeUri: string,
): Promise<Doc<"eventTypeConfigs"> | string> {
	const { existingConfig: config } = await lookupCanonicalEventTypeConfig(ctx, tenantId, calendlyEventTypeUri);
	if (!config || !user.calendlyUserUri || config.calendlyOwnerUri !== user.calendlyUserUri) {
		return CLOSER_LINK_STATUS_LABEL.not_their_calendar + ".";
	}
	const status = calendarStatus(config);
	if (!SETTABLE_STATUSES.has(status)) return `${CLOSER_LINK_STATUS_LABEL[status]}.`;
	if (await isInCoverageCell(ctx, tenantId, config._id)) {
		return "That event type is used in Coverage. Pick the closer's own calendar.";
	}
	return config;
}

/**
 * Puts a closer's link in the DM portal, or takes it out. Turning it on needs
 * a Ready link; turning it off always works.
 */
export const setCloserLinkInPortal = mutation({
	args: { userId: v.id("users"), inPortal: v.boolean() },
	handler: async (ctx, { userId, inPortal }) => {
		const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
		if (!inPortal) {
			const user = await ctx.db.get("users", userId);
			if (!user || user.tenantId !== tenantId) {
				throw rejectRequest("closer_links.not_found", "Closer not found.", { tenantId });
			}
			if (user.closerLinkInPortalAt !== undefined) {
				await ctx.db.patch("users", userId, { closerLinkInPortalAt: undefined });
				log.info("closer_link.portal_changed", { tenantId, userId, inPortal: false });
			}
			return;
		}

		const user = await loadActiveCloser(ctx, tenantId, userId);
		const state = await readCloserLinkState(ctx, user);
		if (state.status !== "ready") {
			throw rejectRequest("closer_links.not_ready", `${CLOSER_LINK_STATUS_LABEL[state.status]}.`, {
				tenantId,
				userId,
				status: state.status,
			});
		}
		if (user.closerLinkInPortalAt === undefined) {
			await ctx.db.patch("users", userId, { closerLinkInPortalAt: Date.now() });
			log.info("closer_link.portal_changed", { tenantId, userId, inPortal: true });
		}
	},
});

function isCalendlyHost(hostname: string) {
	const host = hostname.toLowerCase();
	return host === "calendly.com" || host.endsWith(".calendly.com");
}
