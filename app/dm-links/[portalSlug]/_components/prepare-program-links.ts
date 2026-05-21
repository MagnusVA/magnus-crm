import { buildBookingUrl } from "./build-booking-url";
import type { BookableProgramEventType } from "./group-bookable-programs";

type PrepareProgramLinksInput = {
	closer: {
		teamUtmSource: string;
		utmMedium: string;
	};
	campaign: {
		utmCampaign: string;
	};
	eventTypes: BookableProgramEventType[];
};

export type PreparedProgramLink =
	| {
			status: "ready";
			eventTypeConfigId: string;
			eventTypeDisplayName: string;
			bookingProgramId: string;
			url: string;
	  }
	| {
			status: "invalid_base_url";
			eventTypeConfigId: string;
			eventTypeDisplayName: string;
			bookingProgramId: string;
	  };

export type PreparedProgramLinksResult =
	| { status: "empty"; links: PreparedProgramLink[] }
	| { status: "all_invalid"; links: PreparedProgramLink[] }
	| {
			status: "ready";
			links: PreparedProgramLink[];
			readyLinks: Extract<PreparedProgramLink, { status: "ready" }>[];
	  };

export function prepareProgramLinks(
	input: PrepareProgramLinksInput,
): PreparedProgramLinksResult {
	if (input.eventTypes.length === 0) {
		return { status: "empty", links: [] };
	}

	const links = input.eventTypes.map((eventType) => {
		try {
			return {
				status: "ready" as const,
				eventTypeConfigId: eventType.eventTypeConfigId,
				eventTypeDisplayName: eventType.eventTypeDisplayName,
				bookingProgramId: eventType.bookingProgramId,
				url: buildBookingUrl({
					bookingBaseUrl: eventType.bookingBaseUrl,
					teamUtmSource: input.closer.teamUtmSource,
					closerUtmMedium: input.closer.utmMedium,
					campaign: input.campaign.utmCampaign,
				}),
			};
		} catch {
			return {
				status: "invalid_base_url" as const,
				eventTypeConfigId: eventType.eventTypeConfigId,
				eventTypeDisplayName: eventType.eventTypeDisplayName,
				bookingProgramId: eventType.bookingProgramId,
			};
		}
	});

	const readyLinks = links.filter(
		(link): link is Extract<PreparedProgramLink, { status: "ready" }> =>
			link.status === "ready",
	);

	if (readyLinks.length === 0) {
		return { status: "all_invalid", links };
	}

	return { status: "ready", links, readyLinks };
}
