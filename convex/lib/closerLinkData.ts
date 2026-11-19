// Reads behind closer links, shared by Booking > Closer links, the DM portal
// and its copy check, so all three agree on which closers are Ready.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isCalendlyBookable } from "./bookingSetup/coverage";
import {
	bookingUrlKey,
	closerCalendarUrl,
	closerLinkStatus,
	type CloserLinkStatus,
} from "./closerLinks";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Configs read per Calendly event type, as the booking pipeline does. */
const MAX_CONFIGS_PER_EVENT_TYPE = 8;
/** Event types read per closer. A person owns a handful; more is a sync anomaly. */
const MAX_OWNED_EVENT_TYPES = 100;
/**
 * Round robins read per closer where they are the only host. One more than
 * this means the set is incomplete, and no link is Ready on an incomplete set.
 */
const MAX_SOLE_HOST_EVENT_TYPES = 20;

/**
 * The config the booking pipeline reads for a Calendly event type: the oldest
 * of its duplicates. `candidateCount` reports duplicates.
 */
export async function lookupCanonicalEventTypeConfig(
	ctx: ReadCtx,
	tenantId: Id<"tenants">,
	eventTypeUri: string | undefined,
): Promise<{ existingConfig: Doc<"eventTypeConfigs"> | null; candidateCount: number }> {
	if (!eventTypeUri) return { existingConfig: null, candidateCount: 0 };
	const candidates = await ctx.db
		.query("eventTypeConfigs")
		.withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
			q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
		)
		.take(MAX_CONFIGS_PER_EVENT_TYPE);
	return {
		existingConfig:
			candidates.length === 0
				? null
				: candidates.reduce((best, row) => (row.createdAt < best.createdAt ? row : best)),
		candidateCount: candidates.length,
	};
}

/** Statuses decided before the link is matched to an event type. */
const PRE_MATCH_STATUSES: ReadonlySet<CloserLinkStatus> = new Set([
	"deactivated",
	"not_closer",
	"calendly_not_linked",
	"needs_link",
]);

export type CloserCalendarConfigs = {
	configs: Array<Doc<"eventTypeConfigs">>;
	/** False when the closer is sole host of more round robins than are read. */
	complete: boolean;
};

/**
 * The event types Calendly ties to this Calendly user: the ones they own,
 * and the round robins the event type sync verified they are the only host of.
 */
export async function listCloserCalendarConfigs(
	ctx: ReadCtx,
	tenantId: Id<"tenants">,
	calendlyUserUri: string | undefined,
): Promise<CloserCalendarConfigs> {
	if (!calendlyUserUri) return { configs: [], complete: true };
	const [owned, hosted] = await Promise.all([
		ctx.db
			.query("eventTypeConfigs")
			.withIndex("by_tenantId_and_calendlyOwnerUri", (q) =>
				q.eq("tenantId", tenantId).eq("calendlyOwnerUri", calendlyUserUri),
			)
			.take(MAX_OWNED_EVENT_TYPES),
		ctx.db
			.query("eventTypeConfigs")
			.withIndex("by_tenantId_and_calendlySoleHostUri", (q) =>
				q.eq("tenantId", tenantId).eq("calendlySoleHostUri", calendlyUserUri),
			)
			.take(MAX_SOLE_HOST_EVENT_TYPES + 1),
	]);
	const byId = new Map(owned.map((config) => [config._id, config]));
	for (const config of hosted.slice(0, MAX_SOLE_HOST_EVENT_TYPES)) byId.set(config._id, config);
	return { configs: [...byId.values()], complete: hosted.length <= MAX_SOLE_HOST_EVENT_TYPES };
}

export type CloserLinkState = {
	status: CloserLinkStatus;
	/** The canonical config of the closer's personal link, when it matched one. */
	config: Doc<"eventTypeConfigs"> | null;
	calendars: CloserCalendarConfigs;
};

/** Where a closer's personal link stands, read fresh. */
export async function readCloserLinkState(
	ctx: ReadCtx,
	user: Doc<"users">,
): Promise<CloserLinkState> {
	const calendars = await listCloserCalendarConfigs(ctx, user.tenantId, user.calendlyUserUri);
	const owned = calendars.configs;
	const urlKey = bookingUrlKey(user.personalEventTypeUri);
	const matchedUris = [
		...new Set(
			owned
				.filter(
					(config) =>
						urlKey !== null && isCalendlyBookable(config) && bookingUrlKey(closerCalendarUrl(config)) === urlKey,
				)
				.map((config) => config.calendlyEventTypeUri),
		),
	];
	// Only a single match is used; more is "ambiguous" and needs no lookup.
	const canonical = new Map<string, Doc<"eventTypeConfigs"> | null>();
	if (matchedUris.length === 1) {
		const [uri] = matchedUris;
		if (uri) {
			canonical.set(uri, (await lookupCanonicalEventTypeConfig(ctx, user.tenantId, uri)).existingConfig);
		}
	}
	const { status, config } = closerLinkStatus(user, owned, (uri) => canonical.get(uri) ?? null);
	// An incomplete set can't tell which round robin, if any, the link is.
	// An owned one-on-one match stands: Calendly gives each event type its own
	// URL, so an unread round robin can't share it.
	const ownedMatch = config !== null && !config.calendlyPoolingType;
	if (!calendars.complete && !PRE_MATCH_STATUSES.has(status) && !ownedMatch) {
		return { status: "too_many_calendars", config: null, calendars };
	}
	return { status, config, calendars };
}

/** Whether this closer's link is in the DM portal right now. */
export function isInPortal(user: Doc<"users">, state: CloserLinkState): boolean {
	return user.closerLinkInPortalAt !== undefined && state.status === "ready" && state.config !== null;
}

/** Active phone closers in the tenant (deactivated and removed ones left out). */
export async function listActivePhoneClosers(
	ctx: ReadCtx,
	tenantId: Id<"tenants">,
): Promise<Array<Doc<"users">>> {
	const users = await ctx.db
		.query("users")
		.withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId).eq("isActive", true))
		.take(500);
	return users.filter((user) => user.role === "closer" && user.deletedAt === undefined);
}
