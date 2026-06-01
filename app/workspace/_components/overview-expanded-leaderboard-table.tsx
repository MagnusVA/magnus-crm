"use client";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";

type ExpandedOverviewLeaderboard = FunctionReturnType<
	typeof api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows
>;

export function OverviewExpandedLeaderboardTable({
	data,
}: {
	data: ExpandedOverviewLeaderboard;
}) {
	if (data.kind === "lead_gen") {
		return (
			<Table aria-label="Expanded efficiency leaderboard">
				<TableHeader>
					<TableRow>
						<TableHead className="w-10">#</TableHead>
						<TableHead>Name</TableHead>
						<TableHead className="text-right">Rate</TableHead>
						<TableHead className="text-right">Submissions</TableHead>
						<TableHead className="text-right">Hours</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.rows.map((row, index) => (
						<TableRow key={row.workerId}>
							<TableCell className="text-muted-foreground tabular-nums">
								{index + 1}
							</TableCell>
							<TableCell className="max-w-[12rem]">
								<p className="truncate font-medium">{row.displayName}</p>
								<p className="truncate text-xs text-muted-foreground">
									{formatWholeNumber(row.uniqueProspects)} unique
								</p>
							</TableCell>
							<TableCell className="text-right font-medium tabular-nums">
								{formatDecimal(row.leadsPerHour)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.submissions)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatDecimal(row.scheduledHours)}h
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		);
	}

	if (data.kind === "qualifiers") {
		return (
			<Table aria-label="Expanded efficiency leaderboard">
				<TableHeader>
					<TableRow>
						<TableHead className="w-10">#</TableHead>
						<TableHead>Name</TableHead>
						<TableHead className="text-right">Rate</TableHead>
						<TableHead className="text-right">Qualified</TableHead>
						<TableHead className="text-right">Hours</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.rows.map((row, index) => (
						<TableRow key={row.slackUserId}>
							<TableCell className="text-muted-foreground tabular-nums">
								{index + 1}
							</TableCell>
							<TableCell className="max-w-[12rem]">
								<p className="truncate font-medium">
									{row.displayName ?? row.slackUserId}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{formatWholeNumber(row.booked)} booked
								</p>
							</TableCell>
							<TableCell className="text-right font-medium tabular-nums">
								{formatDecimal(row.qualifiedPerHour)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatWholeNumber(row.uniqueOpportunityCount)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatDecimal(row.scheduledHours)}h
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		);
	}

	return (
		<Table aria-label="Expanded efficiency leaderboard">
			<TableHeader>
				<TableRow>
					<TableHead className="w-10">#</TableHead>
					<TableHead>Name</TableHead>
					<TableHead className="text-right">Rate</TableHead>
					<TableHead className="text-right">Booked</TableHead>
					<TableHead className="text-right">Hours</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.rows.map((row, index) => (
					<TableRow key={row.dmCloserId}>
						<TableCell className="text-muted-foreground tabular-nums">
							{index + 1}
						</TableCell>
						<TableCell className="max-w-[12rem]">
							<p className="truncate font-medium">{row.displayName}</p>
							{row.teamName ? (
								<p className="truncate text-xs text-muted-foreground">
									{row.teamName}
								</p>
							) : null}
						</TableCell>
						<TableCell className="text-right font-medium tabular-nums">
							{formatDecimal(row.bookedPerHour)}
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{formatWholeNumber(row.booked)}
						</TableCell>
						<TableCell className="text-right tabular-nums">
							{formatDecimal(row.scheduledHours)}h
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
