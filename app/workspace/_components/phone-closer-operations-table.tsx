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
					<TableRow>
						<TableHead>Phone closer</TableHead>
						<TableHead className="text-right">Booked calls</TableHead>
						<TableHead className="text-right">Completed</TableHead>
						<TableHead className="text-right">No shows</TableHead>
						<TableHead className="text-right">Review req.</TableHead>
						<TableHead className="text-right">Show rate</TableHead>
						<TableHead className="text-right">No-show rate</TableHead>
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
					<TableRow className="bg-muted/40 hover:bg-muted/40">
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
