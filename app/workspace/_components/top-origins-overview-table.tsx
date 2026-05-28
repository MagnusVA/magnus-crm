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
type TeamRow = ReadyRows[number];

export function TopOriginsOverviewTable({ rows }: { rows: ReadyRows }) {
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			{rows.map((team) => (
				<TeamOriginsTable key={team.teamId ?? "unassigned"} team={team} />
			))}
		</div>
	);
}

function TeamOriginsTable({ team }: { team: TeamRow }) {
	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
			<div className="flex min-w-0 items-center gap-2">
				<h3 className="truncate text-sm font-semibold">{team.teamName}</h3>
				{team.isActive === false ? (
					<Badge variant="secondary">Inactive</Badge>
				) : null}
			</div>
			{team.origins.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No rankable posts for this range.
				</p>
			) : (
				<div className="overflow-x-auto rounded-md border">
					<Table className="min-w-0 table-fixed">
						<TableHeader>
							<TableRow className="bg-muted/40 hover:bg-muted/40">
								<TableHead className="w-[44%] font-semibold text-foreground/80">
									<OverviewHelpTooltip
										label="Post/reel"
										description={overviewTooltips.topOrigins.origin}
									>
										Post/reel
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
										label="Leads"
										description={
											overviewTooltips.topOrigins.uniqueProspects
										}
										triggerClassName="justify-end w-full"
									>
										Leads
									</OverviewHelpTooltip>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{team.origins.map((origin) => (
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
										{formatWholeNumber(origin.uniqueProspects)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
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
