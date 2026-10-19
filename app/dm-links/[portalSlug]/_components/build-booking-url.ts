type BuildBookingUrlInput = {
	bookingBaseUrl: string;
	teamUtmSource: string;
	closerUtmMedium: string;
	campaign: string;
};

export function buildBookingUrl(input: BuildBookingUrlInput) {
	const url = new URL(input.bookingBaseUrl);
	url.searchParams.set("utm_source", input.teamUtmSource);
	url.searchParams.set("utm_medium", input.closerUtmMedium);
	url.searchParams.set("utm_campaign", input.campaign);
	return url.toString();
}

/**
 * Names the person the link is for in `utm_content`, so their booking joins
 * them (docs/plans/phase-2-person-first.md §4.4).
 */
export function addBookingPerson(bookingUrl: string, personId: string) {
	const url = new URL(bookingUrl);
	url.searchParams.set("utm_content", personId);
	return url.toString();
}
