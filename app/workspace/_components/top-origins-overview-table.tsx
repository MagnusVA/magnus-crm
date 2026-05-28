import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatOriginValue, formatWholeNumber } from "./overview-formatters";
import type { TopOriginsSection } from "./overview-dashboard-types";

type ReadyRows = Extract<TopOriginsSection, { status: "ready" }>["data"]["rows"];

export function TopOriginsOverviewTable({ rows }: { rows: ReadyRows }) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<Table className="min-w-[44rem] table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead className="w-[56%]">Origin</TableHead>
						<TableHead>Kind</TableHead>
						<TableHead className="text-right">Submissions</TableHead>
						<TableHead className="text-right">Unique prospects</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={`${row.source}:${row.originKey}`}>
							<TableCell className="max-w-0">
								<OriginValue value={row.originValue} />
							</TableCell>
							<TableCell>
								<Badge variant="outline">
									{formatOriginKind(row.originKind)}
								</Badge>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.submissions)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.uniqueProspects)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function OriginValue({ value }: { value: string }) {
	const formatted = formatOriginValue(value);
	if (!isExternalUrl(value)) {
		return <span className="block truncate">{formatted}</span>;
	}

	return (
		<a
			className="flex min-w-0 items-center gap-2 truncate underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			href={value}
			rel="noreferrer"
			target="_blank"
			title={value}
		>
			<span className="truncate">{formatted}</span>
			<ExternalLinkIcon aria-hidden="true" />
		</a>
	);
}

function isExternalUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function formatOriginKind(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
