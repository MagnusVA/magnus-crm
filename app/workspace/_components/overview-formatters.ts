const numberFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
});

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});

const rateFormatter = new Intl.NumberFormat(undefined, {
	style: "percent",
	maximumFractionDigits: 0,
});

export function formatWholeNumber(value: number) {
	return numberFormatter.format(value);
}

export function formatCompactNumber(value: number) {
	return compactNumberFormatter.format(value);
}

export function formatDecimal(value: number | null, digits = 1) {
	if (value === null || !Number.isFinite(value)) return "N/A";
	return value.toLocaleString(undefined, {
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
	});
}

export function formatRate(value: number | null) {
	return value === null || !Number.isFinite(value)
		? "N/A"
		: rateFormatter.format(value);
}

export function formatCurrency(minorUnits: number) {
	return `$${(minorUnits / 100).toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export function formatOriginValue(originValue: string) {
	try {
		const url = new URL(originValue);
		return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
	} catch {
		return originValue;
	}
}
