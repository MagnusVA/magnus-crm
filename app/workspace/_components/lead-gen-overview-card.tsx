import { ClipboardListIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { LeadGenOverviewSection } from "./overview-dashboard-types";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import {
	OverviewCappedState,
	OverviewEmptyState,
	OverviewErrorState,
} from "./overview-section-state";

export function LeadGenOverviewCard({
	section,
}: {
	section: LeadGenOverviewSection;
}) {
	return (
		<Card className="min-w-0" size="sm">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<ClipboardListIcon aria-hidden="true" />
					Lead Gen
				</CardTitle>
				<CardDescription>
					Submissions, uniqueness, and top generators
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{section.status === "capped" ? (
					<OverviewCappedState message={section.message} />
				) : section.status === "error" ? (
					<OverviewErrorState message={section.message} />
				) : section.status === "empty" ? (
					<OverviewEmptyState message={section.message} />
				) : (
					<>
						<div className="grid grid-cols-3 gap-3">
							<Metric
								label="Submissions"
								value={formatWholeNumber(section.data.totalSubmissions)}
							/>
							<Metric
								label="Unique"
								value={formatWholeNumber(section.data.uniqueProspects)}
							/>
							<Metric
								label="Leads/hr"
								value={formatDecimal(section.data.leadsPerHour)}
							/>
						</div>
						<ol className="flex flex-col gap-2" aria-label="Top lead generators">
							{section.data.topWorkers.map((worker, index) => (
								<li
									key={worker.workerId}
									className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm"
								>
									<span className="text-muted-foreground tabular-nums">
										{index + 1}
									</span>
									<span className="truncate font-medium">
										{worker.displayName}
									</span>
									<span className="tabular-nums">
										{formatWholeNumber(worker.submissions)}
									</span>
								</li>
							))}
						</ol>
					</>
				)}
			</CardContent>
		</Card>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<p className="truncate text-xs text-muted-foreground">{label}</p>
			<p className="text-lg font-semibold tabular-nums">{value}</p>
		</div>
	);
}
