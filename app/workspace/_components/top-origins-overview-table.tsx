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
import {
	OverviewHelpTooltip,
	overviewTooltips,
} from "./overview-help-tooltip";

type ReadyRows = Extract<TopOriginsSection, { status: "ready" }>["data"]["rows"];

export function TopOriginsOverviewTable({ rows }: { rows: ReadyRows }) {
	return (
		<div className="max-h-[min(32rem,calc(100vh-16rem))] overflow-auto rounded-md border">
			<Table className="min-w-[44rem] table-fixed">
				<TableHeader className="sticky top-0 z-10 bg-background">
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="w-[18%] font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Team"
								description={overviewTooltips.topOrigins.team}
							>
								Team
							</OverviewHelpTooltip>
						</TableHead>
						<TableHead className="w-[38%] font-semibold text-foreground/80">
							<OverviewHelpTooltip
								label="Top post/reel"
								description={overviewTooltips.topOrigins.origin}
							>
								Top post/reel
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
					{rows.map((row) => (
						<TableRow key={row.teamId ?? "unassigned"}>
							<TableCell className="max-w-0">
								<div className="flex min-w-0 items-center gap-2">
									<span className="truncate font-medium">
										{row.teamName}
									</span>
									{row.isActive === false ? (
										<Badge variant="secondary">Inactive</Badge>
									) : null}
								</div>
							</TableCell>
							<TableCell className="max-w-0">
								{row.topOrigin ? (
									<OriginValue value={row.topOrigin.originValue} />
								) : (
									<span className="text-muted-foreground">-</span>
								)}
							</TableCell>
							<TableCell>
								{row.topOrigin ? (
									<Badge variant="outline">
										{formatOriginKind(row.topOrigin.originKind)}
									</Badge>
								) : (
									<span className="text-muted-foreground">-</span>
								)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.topOrigin?.submissions ?? 0)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.topOrigin?.uniqueProspects ?? 0)}
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
			<ExternalLinkIcon aria-hidden="true" className="shrink-0" />
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
