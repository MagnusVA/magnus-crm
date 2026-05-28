import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { PhoneCloserOperationsSectionData } from "./overview-dashboard-types";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";
import { PhoneCloserOperationsTable } from "./phone-closer-operations-table";

export function PhoneCloserOperationsSection({
	section,
}: {
	section: PhoneCloserOperationsSectionData;
}) {
	return (
		<Card>
			<CardHeader className="pb-4">
				<CardTitle>
					<OverviewHelpTooltip
						label="Phone Closer Operations"
						description={overviewTooltips.phoneCloserOperations.section}
					>
						Phone Closer Operations
					</OverviewHelpTooltip>
				</CardTitle>
				<CardDescription>
					Booked-call outcomes by assigned phone closer.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{section.status === "capped" ? (
					<OverviewCappedState message={section.message} />
				) : section.status === "error" ? (
					<OverviewErrorState message={section.message} />
				) : section.status === "empty" ? (
					<OverviewEmptyState message={section.message} />
				) : (
					<PhoneCloserOperationsTable data={section.data} />
				)}
			</CardContent>
		</Card>
	);
}
