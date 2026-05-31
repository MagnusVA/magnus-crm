import type { LeadCustomerSearchRowDto } from "@/convex/leadCustomers/types";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

const MONEY_FORMATTERS = new Map<string, Intl.NumberFormat>();

export function formatDate(value: number | undefined) {
	if (value === undefined) return "Not recorded";
	return DATE_FORMATTER.format(new Date(value));
}

export function formatMoneyMinor(value: number | undefined, currency = "USD") {
	const formatterKey = currency;
	let formatter = MONEY_FORMATTERS.get(formatterKey);
	if (!formatter) {
		formatter = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
			maximumFractionDigits: 0,
		});
		MONEY_FORMATTERS.set(formatterKey, formatter);
	}

	return formatter.format((value ?? 0) / 100);
}

export function lifecycleLabel(row: LeadCustomerSearchRowDto) {
	return row.lifecycle === "customer" ? "Customer" : "Lead";
}

export function primaryLine(row: LeadCustomerSearchRowDto) {
	return row.displayName || row.email || row.phone || row.primaryIdentifier || row.leadId;
}

export function secondaryLine(row: LeadCustomerSearchRowDto) {
	return row.email ?? row.phone ?? row.primaryIdentifier ?? row.leadId;
}

export function entityDetailHref(row: LeadCustomerSearchRowDto) {
	const params = new URLSearchParams();
	if (row.selectedOpportunityId) {
		params.set("opportunityId", row.selectedOpportunityId);
	}
	const suffix = params.toString();
	return `/workspace/leads-customers/${row.leadId}${suffix ? `?${suffix}` : ""}`;
}
