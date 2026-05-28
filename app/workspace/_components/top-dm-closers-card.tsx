import { SendIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { TopDmClosersSection } from "./overview-dashboard-types";
import { formatRate, formatWholeNumber } from "./overview-formatters";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";

export function TopDmClosersCard({
	section,
}: {
	section: TopDmClosersSection;
}) {
	return (
		<Card className="min-w-0" size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<SendIcon aria-hidden="true" />
					Top DM Closers
				</CardTitle>
				<CardDescription>Ranked by booked-call attribution</CardDescription>
			</CardHeader>
			<CardContent>
				{section.status === "capped" ? (
					<OverviewCappedState message={section.message} />
				) : section.status === "error" ? (
					<OverviewErrorState message={section.message} />
				) : section.status === "empty" ? (
					<OverviewEmptyState message={section.message} />
				) : (
					<ol className="flex flex-col gap-3" aria-label="Top DM closers">
						{section.data.rows.map((row, index) => (
							<li
								key={row.dmCloserId}
								className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm"
							>
								<span className="text-muted-foreground tabular-nums">
									{index + 1}
								</span>
								<div className="min-w-0">
									<p className="truncate font-medium">{row.displayName}</p>
									<p className="truncate text-xs text-muted-foreground">
										{row.teamName ?? "No team"} / {formatRate(row.showRate)} show
									</p>
								</div>
								<span className="font-medium tabular-nums">
									{formatWholeNumber(row.scheduled)}
								</span>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
