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
	formatCurrency,
	formatRate,
	formatWholeNumber,
} from "./overview-formatters";

type ReadyData = Extract<
	PhoneCloserOperationsSectionData,
	{ status: "ready" }
>["data"];

export function PhoneCloserOperationsTable({ data }: { data: ReadyData }) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<Table className="min-w-[44rem]">
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="font-semibold text-foreground/80">
							Phone closer
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							Booked calls
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							No shows
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							No-show rate
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							Close rate
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							Cash collected
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
							<NumericCell value={formatWholeNumber(row.noShows)} />
							<NumericCell value={formatRate(row.noShowRate)} />
							<NumericCell value={formatRate(row.closeRate)} />
							<NumericCell value={formatCurrency(row.cashCollectedMinor)} />
						</TableRow>
					))}
					<TableRow className="border-t-2 bg-muted/30 hover:bg-muted/30">
						<TableCell className="font-semibold">Total</TableCell>
						<NumericCell strong value={formatWholeNumber(data.totals.scheduled)} />
						<NumericCell strong value={formatWholeNumber(data.totals.noShows)} />
						<NumericCell strong value={formatRate(data.totals.noShowRate)} />
						<NumericCell strong value={formatRate(data.totals.closeRate)} />
						<NumericCell
							strong
							value={formatCurrency(data.totals.cashCollectedMinor)}
						/>
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
