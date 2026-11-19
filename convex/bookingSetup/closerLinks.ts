// Booking > Closer links: each active phone closer's personal Calendly link,
// whether it is in the DM portal, and the programs' link codes.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { isCalendlyBookable } from "../lib/bookingSetup/coverage";
import {
	CLOSER_LINK_STATUS_LABEL,
	bookingUrlKey,
	calendarHolderUri,
	calendarStatus,
	closerCalendarUrl,
	isTiedToUser,
	type CloserLinkStatus,
} from "../lib/closerLinks";
import {
	isInPortal,
	listActivePhoneClosers,
	listCloserCalendarConfigs,
	lookupCanonicalEventTypeConfig,
	readCloserLinkState,
	type CloserCalendarConfigs,
} from "../lib/closerLinkData";
import { userMemberIdentity } from "../lib/memberIdentity";
import { log } from "../lib/observability/log";
import { rejectRequest } from "../lib/observability/errors";
import { isActiveLogin } from "../lib/teamMembers";
import { requireTenantUser } from "../requireTenantUser";
import { listProgramsForTenant, sortProgramsForDisplay } from "../tenantPrograms/shared";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;

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
				const inPortal = isInPortal(user, state);
				return {
					userId: user._id,
					name: user.fullName?.trim() || user.email,
					avatar: await userMemberIdentity(ctx, user),
					calendlyLinked: user.calendlyUserUri !== undefined,
					personalEventTypeUri: user.personalEventTypeUri ?? null,
					/** Whether DM setters see this closer in the portal right now. */
					inPortal,
					/** Switched on, but hidden until the link is Ready again. */
					portalPaused: user.closerLinkInPortalAt !== undefined && !inPortal,
					status: state.status,
					statusLabel: CLOSER_LINK_STATUS_LABEL[state.status],
					linkEventTypeConfigId: state.config?._id ?? null,
					/** Kept empty for admin tabs opened before the editor read its own options. */
					options: [] as never[],
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

/**
 * The event types a closer's editor offers: each one Calendly ties to them as
 * their own calendar, with the reason saving it would be refused, if any.
 * Read when the editor opens, so the list query stays one lookup per closer.
 */
export const listCloserCalendarOptions = query({
	args: { userId: v.id("users") },
	handler: async (ctx, { userId }) => {
		const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
		const user = await loadActiveCloser(ctx, tenantId, userId);
		const calendlyUserUri = user.calendlyUserUri;
		if (!calendlyUserUri) return [];
		const calendars = await listCloserCalendarConfigs(ctx, tenantId, calendlyUserUri);
		const uris = new Set(
			calendars.configs
				.filter(
					(config) => calendarHolderUri(config) === calendlyUserUri && config.calendlySyncStatus !== "deleted",
				)
				.map((config) => config.calendlyEventTypeUri),
		);
		const options = await Promise.all(
			[...uris].map(async (uri) => {
				const check = await checkPick(ctx, tenantId, user, uri, calendars);
				const shown =
					"refused" in check
						? calendars.configs.find((config) => config.calendlyEventTypeUri === uri)
						: check.config;
				if (!shown) return null;
				return {
					eventTypeConfigId: shown._id,
					displayName: shown.displayName,
					url: closerCalendarUrl(shown) ?? null,
					durationMinutes: shown.calendlyDurationMinutes ?? null,
					pooled: Boolean(shown.calendlyPoolingType),
					/** Why saving it would be refused; null when it can be picked. */
					disabledReason: "refused" in check ? check.refused.message : null,
				};
			}),
		);
		return options
			.filter((option) => option !== null)
			.sort((left, right) => left.displayName.localeCompare(right.displayName));
	},
});

async function loadActiveCloser(ctx: ReadCtx, tenantId: Id<"tenants">, userId: Id<"users">) {
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

async function isInCoverageCell(ctx: ReadCtx, tenantId: Id<"tenants">, eventTypeConfigId: Id<"eventTypeConfigs">) {
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

type PickCheck =
	| { config: Doc<"eventTypeConfigs"> }
	| { refused: { code: string; message: string } };

/**
 * Whether a closer can use one of their Calendly event types as their closer
 * link: its canonical config if so, else why not. The editor's options and
 * the save mutation both use it, so the editor never offers what save refuses.
 */
async function checkPick(
	ctx: ReadCtx,
	tenantId: Id<"tenants">,
	user: Doc<"users">,
	calendlyEventTypeUri: string,
	calendars: CloserCalendarConfigs,
): Promise<PickCheck> {
	const usable = await usableCalendar(ctx, tenantId, user, calendlyEventTypeUri);
	if (typeof usable === "string") {
		return { refused: { code: "closer_links.calendar_unusable", message: usable } };
	}
	// An owned one-on-one has its own URL in Calendly; a round robin needs the
	// closer's whole set to rule out another event type on the same URL.
	if (!calendars.complete && usable.calendlyPoolingType) {
		return {
			refused: {
				code: "closer_links.too_many_calendars",
				message: `${CLOSER_LINK_STATUS_LABEL.too_many_calendars}.`,
			},
		};
	}
	// Readiness matches the personal link by URL, so it must name one event type.
	const key = bookingUrlKey(closerCalendarUrl(usable));
	const sameUrl = new Set(
		calendars.configs
			.filter((row) => isCalendlyBookable(row) && bookingUrlKey(closerCalendarUrl(row)) === key)
			.map((row) => row.calendlyEventTypeUri),
	);
	if (key === null || sameUrl.size !== 1) {
		return { refused: { code: "closer_links.ambiguous", message: `${CLOSER_LINK_STATUS_LABEL.ambiguous}.` } };
	}
	return { config: usable };
}

/**
 * Sets a closer's personal link: one of their own Calendly event types (a
 * one-on-one, or a round robin they are the only host of), picked or pasted.
 * The link also serves their follow-up and no-show reschedule links. Turns on
 * "program from link" for that event type; an event type the closer used
 * before keeps it, so links already sent resolve.
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
		const calendars = await listCloserCalendarConfigs(ctx, tenantId, user.calendlyUserUri);
		if (args.eventTypeConfigId !== undefined) {
			const picked = await ctx.db.get("eventTypeConfigs", args.eventTypeConfigId);
			if (!picked || picked.tenantId !== tenantId || !isTiedToUser(picked, user.calendlyUserUri)) {
				throw rejectRequest(
					"closer_links.not_their_calendar",
					"That event type isn't one of this closer's in Calendly.",
					{ tenantId, userId: user._id },
				);
			}
			const check = await checkPick(ctx, tenantId, user, picked.calendlyEventTypeUri, calendars);
			if ("refused" in check) {
				throw rejectRequest(check.refused.code, check.refused.message, {
					tenantId,
					userId: user._id,
					eventTypeConfigId: picked._id,
				});
			}
			config = check.config;
			url = closerCalendarUrl(check.config) ?? "";
		} else {
			const pasted = args.url?.trim() ?? "";
			const key = bookingUrlKey(pasted);
			if (key === null || !isCalendlyHost(new URL(pasted).hostname)) {
				throw rejectRequest("closer_links.invalid_url", "Paste a full Calendly link.", { tenantId });
			}
			url = pasted;
			const uris = new Set(
				calendars.configs
					.filter((row) => isCalendlyBookable(row) && bookingUrlKey(closerCalendarUrl(row)) === key)
					.map((row) => row.calendlyEventTypeUri),
			);
			const [uri] = [...uris];
			if (uris.size === 1 && uri) {
				const match = await checkPick(ctx, tenantId, user, uri, calendars);
				if ("config" in match) {
					config = match.config;
					url = closerCalendarUrl(match.config) ?? pasted;
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
			pooled: config ? Boolean(config.calendlyPoolingType) : undefined,
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
	ctx: ReadCtx,
	tenantId: Id<"tenants">,
	user: Doc<"users">,
	calendlyEventTypeUri: string,
): Promise<Doc<"eventTypeConfigs"> | string> {
	const { existingConfig: config } = await lookupCanonicalEventTypeConfig(ctx, tenantId, calendlyEventTypeUri);
	if (!config || !isTiedToUser(config, user.calendlyUserUri)) {
		return CLOSER_LINK_STATUS_LABEL.not_their_calendar + ".";
	}
	const status = calendarStatus(config, user.calendlyUserUri);
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
