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
