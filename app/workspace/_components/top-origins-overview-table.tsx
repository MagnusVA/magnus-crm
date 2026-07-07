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
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";

export type TopOriginOverviewRow = {
	originKey: string;
	source: string;
	originKind: string;
	originValue: string;
	submissions: number;
	uniqueProspects: number;
};

export function TopOriginsOverviewTable({
	rows,
}: {
	rows: TopOriginOverviewRow[];
}) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<Table className="min-w-[44rem] table-fixed">
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="w-[48%] font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Origin"
								description={overviewTooltips.topOrigins.origin}
							>
								Origin
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Kind"
								description={overviewTooltips.topOrigins.kind}
							>
								Kind
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Submissions"
								description={overviewTooltips.topOrigins.submissions}
								triggerClassName="justify-end w-full"
							>
								Submissions
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="text-right font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Unique prospects"
								description={overviewTooltips.topOrigins.uniqueProspects}
								triggerClassName="justify-end w-full"
							>
								Unique prospects
							</OverviewHelpTooltip>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((origin) => (
						<TableRow key={`${origin.source}:${origin.originKey}`}>
							<TableCell className="max-w-0">
								<OriginValue value={origin.originValue} />
							</TableCell>
							<TableCell>
								<Badge variant="outline">
									{formatOriginKind(origin.originKind)}
								</Badge>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(origin.submissions)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(origin.uniqueProspects)}
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
		return <span className="block truncate text-sm">{formatted}</span>;
	}

	return (
		<a
			className="flex min-w-0 items-center gap-1.5 truncate text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			href={value}
			rel="noreferrer"
			target="_blank"
			title={value}
		>
			<span className="truncate">{formatted}</span>
			<ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
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
