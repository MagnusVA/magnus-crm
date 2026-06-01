import { cn } from "@/lib/utils";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { PhoneCloserOperationsSectionData } from "./overview-dashboard-types";
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";
import { formatRate, formatWholeNumber } from "./overview-formatters";

type ReadyData = Extract<
	PhoneCloserOperationsSectionData,
	{ status: "ready" }
>["data"];

export function PhoneCloserOperationsTable({ data }: { data: ReadyData }) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<Table className="min-w-[52rem]">
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Phone closer"
								description={overviewTooltips.phoneCloserOperations.closer}
							>
								Phone closer
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Booked calls"
								description={overviewTooltips.phoneCloserOperations.bookedCalls}
								triggerClassName="justify-end w-full"
							>
								Booked calls
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Completed"
								description={overviewTooltips.phoneCloserOperations.completed}
								triggerClassName="justify-end w-full"
							>
								Completed
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="No shows"
								description={overviewTooltips.phoneCloserOperations.noShows}
								triggerClassName="justify-end w-full"
							>
								No shows
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Review required"
								description={
									overviewTooltips.phoneCloserOperations.reviewRequired
								}
								triggerClassName="justify-end w-full"
							>
								Review req.
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Show rate"
								description={overviewTooltips.phoneCloserOperations.showRate}
								triggerClassName="justify-end w-full"
							>
								Show rate
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="No-show rate"
								description={overviewTooltips.phoneCloserOperations.noShowRate}
								triggerClassName="justify-end w-full"
							>
								No-show rate
							</OverviewHelpTooltip>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.rows.map((row) => (
						<TableRow key={row.closerId}>
							<TableCell className="max-w-64 truncate font-medium">
								{row.closerName}
							</TableCell>
							<NumericCell value={formatWholeNumber(row.scheduled)} />
							<NumericCell value={formatWholeNumber(row.completed)} />
							<NumericCell value={formatWholeNumber(row.noShows)} />
							<NumericCell value={formatWholeNumber(row.reviewRequired)} />
							<NumericCell value={formatRate(row.showRate)} />
							<NumericCell value={formatRate(row.noShowRate)} />
						</TableRow>
					))}
					<TableRow className="border-t-2 bg-muted/30 hover:bg-muted/30">
						<TableCell className="font-semibold">Total</TableCell>
						<NumericCell strong value={formatWholeNumber(data.totals.scheduled)} />
						<NumericCell strong value={formatWholeNumber(data.totals.completed)} />
						<NumericCell strong value={formatWholeNumber(data.totals.noShows)} />
						<NumericCell
							strong
							value={formatWholeNumber(data.totals.reviewRequired)}
						/>
						<NumericCell strong value={formatRate(data.totals.showRate)} />
						<NumericCell strong value={formatRate(data.totals.noShowRate)} />
					</TableRow>
				</TableBody>
			</Table>
		</div>
	);
}

function NumericCell({
	value,
	strong = false,
}: {
	value: string;
	strong?: boolean;
}) {
	return (
		<TableCell
			className={cn(
				"text-right tabular-nums",
				strong ? "font-semibold" : undefined,
			)}
		>
			{value}
		</TableCell>
	);
}
