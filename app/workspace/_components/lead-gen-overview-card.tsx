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
					<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
						<ClipboardListIcon className="h-3.5 w-3.5" aria-hidden="true" />
					</span>
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
						<div className="grid grid-cols-3 divide-x rounded-lg border bg-muted/30">
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
						<ol className="flex flex-col gap-0.5" aria-label="Top lead generators">
							{section.data.topWorkers.map((worker, index) => (
								<li
									key={worker.workerId}
									className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
								>
									<span className="text-center text-xs font-semibold tabular-nums text-muted-foreground/60">
										{index + 1}
									</span>
									<span className="truncate font-medium">
										{worker.displayName}
									</span>
									<span className="font-semibold tabular-nums">
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
		<div className="min-w-0 px-3 py-2.5">
			<p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{label}
			</p>
			<p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">
				{value}
			</p>
		</div>
	);
}
