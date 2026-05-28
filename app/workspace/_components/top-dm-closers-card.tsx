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
					<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<SendIcon className="h-3.5 w-3.5" aria-hidden="true" />
					</span>
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
					<ol className="flex flex-col gap-0.5" aria-label="Top DM closers">
						{section.data.rows.map((row, index) => (
							<li
								key={row.dmCloserId}
								className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
							>
								<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
									{index + 1}
								</span>
								<div className="min-w-0">
									<p className="truncate font-medium">{row.displayName}</p>
									<p className="truncate text-xs text-muted-foreground">
										{row.teamName ?? "No team"}&nbsp;·&nbsp;{formatRate(row.showRate)} show
									</p>
								</div>
								<span className="font-semibold tabular-nums">
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
