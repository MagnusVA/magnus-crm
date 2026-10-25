const DATE_FORMAT_OPTIONS = {
	month: "short",
	day: "numeric",
	year: "numeric",
} as const;
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", DATE_FORMAT_OPTIONS);

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
});

const MONEY_FORMATTERS = new Map<string, Intl.NumberFormat>();

/** `timeZone`, when given, picks the calendar day; the default is the browser's. */
export function formatDate(value: number | undefined | null, timeZone?: string) {
	if (!value) return "Not recorded";
	if (!timeZone) return DATE_FORMATTER.format(new Date(value));
	return new Intl.DateTimeFormat("en-US", {
		...DATE_FORMAT_OPTIONS,
		timeZone,
	}).format(new Date(value));
}

export function formatDateTime(value: number | undefined | null) {
	if (!value) return "Not recorded";
	return DATE_TIME_FORMATTER.format(new Date(value));
}

export function formatMoneyMinor(value: number | undefined, currency = "USD") {
	const key = currency;
	let formatter = MONEY_FORMATTERS.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
			maximumFractionDigits: 0,
		});
		MONEY_FORMATTERS.set(key, formatter);
	}

	return formatter.format((value ?? 0) / 100);
}

export function formatToken(value: string | undefined) {
	if (!value) return "Not set";
	return value.replaceAll("_", " ");
}

/** What a program or person has paid; payments in more than one currency don't add up. */
export function formatPaidTotal(paid: {
	totalPaidMinor: number | null;
	currency: string | null;
	paymentCount: number;
}) {
	if (paid.totalPaidMinor === null) return "Mixed currencies";
	return formatMoneyMinor(paid.totalPaidMinor, paid.currency ?? undefined);
}

export function formatPaymentCount(count: number) {
	return `${count} payment${count === 1 ? "" : "s"}`;
}
