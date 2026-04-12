"use client";

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { Doc } from "@/convex/_generated/dataModel";

type LeadDetailMeeting = Doc<"meetings"> & {
	opportunityStatus: string;
	closerName: string | null;
};

interface LeadCustomFieldsTabProps {
	lead: Doc<"leads">;
	meetings: LeadDetailMeeting[];
}

/**
 * Converts a snake_case or camelCase key to Title Case.
 * e.g. "referral_source" -> "Referral Source", "companyName" -> "Company Name"
 */
function formatFieldKey(key: string): string {
	return key
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Formats a field value for display. Handles primitives, dates (numbers
 * that look like timestamps), arrays, and objects.
 */
function formatFieldValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "--";
	}

	if (typeof value === "boolean") {
		return value ? "Yes" : "No";
	}

	if (typeof value === "number") {
		// Treat large numbers as timestamps (milliseconds since epoch)
		if (value > 1_000_000_000_000 && value < 10_000_000_000_000) {
			return new Date(value).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			});
		}
		return String(value);
	}

	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(String).join(", ");
	}

	return JSON.stringify(value);
}

export function LeadCustomFieldsTab({
	lead,
	meetings: _meetings,
}: LeadCustomFieldsTabProps) {
	const customFields = lead.customFields;
	const hasFields =
		customFields !== undefined &&
		customFields !== null &&
		typeof customFields === "object" &&
		Object.keys(customFields as Record<string, unknown>).length > 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Custom Fields</CardTitle>
				<CardDescription>
					Additional data captured from booking forms and integrations
				</CardDescription>
			</CardHeader>
			<CardContent>
				{!hasFields ? (
					<p className="text-sm text-muted-foreground">
						No custom fields recorded for this lead.
					</p>
				) : (
					<dl className="divide-y">
						{Object.entries(customFields as Record<string, unknown>).map(
							([key, value]) => (
								<div
									key={key}
									className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4"
								>
									<dt className="w-48 shrink-0 text-sm font-medium text-muted-foreground">
										{formatFieldKey(key)}
									</dt>
									<dd className="text-sm">{formatFieldValue(value)}</dd>
								</div>
							),
						)}
					</dl>
				)}
			</CardContent>
		</Card>
	);
}
