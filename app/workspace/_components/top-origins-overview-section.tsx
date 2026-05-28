import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { TopOriginsSection } from "./overview-dashboard-types";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";
import { TopOriginsOverviewTable } from "./top-origins-overview-table";

export function TopOriginsOverviewSection({
	section,
}: {
	section: TopOriginsSection;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Top Posts & Reels</CardTitle>
				<CardDescription>
					Ranked by submissions for the selected range.
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
					<TopOriginsOverviewTable rows={section.data.rows} />
				)}
			</CardContent>
		</Card>
	);
}
