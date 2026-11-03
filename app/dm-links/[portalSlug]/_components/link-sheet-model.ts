import { buildBookingUrl } from "./build-booking-url";
import {
	eventTypesForTeam,
	groupBookablePrograms,
	type BookableProgramEventType,
	type SchedulingMode,
} from "./group-bookable-programs";
import type { PortalCampaign, PortalCloser } from "./portal-types";

export type LinkTile = {
	/** `programId|mode|eventTypeConfigId`, stable across campaigns. */
	key: string;
	mode: SchedulingMode;
	eventTypeConfigId: string;
	eventTypeDisplayName: string;
	bookingBaseUrl: string;
	/**
	 * Set when a program has more than one event type in this mode for the
	 * team, so the closer can tell the tiles apart.
	 */
	eventTypeHint: string | null;
};

export type LinkSheetProgram = {
	programId: string;
	programName: string;
	tiles: LinkTile[];
};

const MODE_ORDER: SchedulingMode[] = ["normal", "extended"];

function modeOf(eventType: BookableProgramEventType): SchedulingMode {
	return eventType.isExtended ? "extended" : "normal";
}

function hasUsableBaseUrl(bookingBaseUrl: string) {
	try {
		const url = new URL(bookingBaseUrl);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

/**
 * Concept C's one sheet of links: every program the closer's team can book,
 * Priority first and Standard second. The server already sends only the
 * event types the team's coverage gives it (`teamIds`); a booking URL that
 * can't be parsed is hidden here rather than failing at copy time.
 */
export function buildLinkSheet(
	eventTypes: BookableProgramEventType[],
	closer: Pick<PortalCloser, "teamId">,
): LinkSheetProgram[] {
	return groupBookablePrograms(eventTypesForTeam(eventTypes, closer))
		.map((program) => {
			const usable = program.eventTypes.filter((eventType) =>
				hasUsableBaseUrl(eventType.bookingBaseUrl),
			);
			const tiles = MODE_ORDER.flatMap((mode) => {
				const inMode = usable
					.filter((eventType) => modeOf(eventType) === mode)
					.sort((left, right) =>
						left.eventTypeDisplayName.localeCompare(right.eventTypeDisplayName),
					);
				return inMode.map(
					(eventType): LinkTile => ({
						key: `${program.bookingProgramId}|${mode}|${eventType.eventTypeConfigId}`,
						mode,
						eventTypeConfigId: eventType.eventTypeConfigId,
						eventTypeDisplayName: eventType.eventTypeDisplayName,
						bookingBaseUrl: eventType.bookingBaseUrl,
						eventTypeHint:
							inMode.length > 1 ? eventType.eventTypeDisplayName : null,
					}),
				);
			});
			return {
				programId: program.bookingProgramId,
				programName: program.bookingProgramName,
				tiles,
			};
		})
		.filter((program) => program.tiles.length > 0);
}

export function buildTileUrl(
	tile: LinkTile,
	closer: Pick<PortalCloser, "teamUtmSource" | "utmMedium">,
	campaign: Pick<PortalCampaign, "utmCampaign">,
) {
	return buildBookingUrl({
		bookingBaseUrl: tile.bookingBaseUrl,
		teamUtmSource: closer.teamUtmSource,
		closerUtmMedium: closer.utmMedium,
		campaign: campaign.utmCampaign,
	});
}

export function defaultCampaign(campaigns: PortalCampaign[]) {
	return campaigns.find((campaign) => campaign.isDefault) ?? campaigns[0] ?? null;
}

export function firstName(name: string) {
	return name.trim().split(/\s+/)[0] ?? name;
}

/** Teams in the order they first appear, each with its closers sorted by name. */
export function closersByTeam(closers: PortalCloser[], search: string) {
	const query = search.trim().toLowerCase();
	const teams = new Map<string, { teamId: string; teamName: string; closers: PortalCloser[] }>();
	for (const closer of closers) {
		if (query && !closer.displayName.toLowerCase().includes(query)) continue;
		const team = teams.get(closer.teamId) ?? {
			teamId: closer.teamId,
			teamName: closer.teamDisplayName,
			closers: [],
		};
		team.closers.push(closer);
		teams.set(closer.teamId, team);
	}
	return [...teams.values()]
		.sort((left, right) => left.teamName.localeCompare(right.teamName))
		.map((team) => ({
			...team,
			closers: [...team.closers].sort((left, right) =>
				left.displayName.localeCompare(right.displayName),
			),
		}));
}
