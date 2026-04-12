"use client";

import { useMemo } from "react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SortableHeader } from "@/components/sortable-header";
import { useTableSort } from "@/hooks/use-table-sort";
import {
	Empty,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
	EmptyDescription,
} from "@/components/ui/empty";
import { LeadStatusBadge } from "./lead-status-badge";
import { SearchIcon, InboxIcon } from "lucide-react";
import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";

type LeadRow = {
	_id: Id<"leads">;
	fullName?: string;
	email: string;
	phone?: string;
	status?: "active" | "converted" | "merged";
	socialHandles?: Array<{ type: string; handle: string }>;
	opportunityCount?: number;
	latestMeetingAt?: number | null;
	assignedCloserName?: string | null;
};

interface LeadsTableProps {
	leads: LeadRow[];
	isSearching: boolean;
	isLoading: boolean;
	canLoadMore: boolean;
	onLoadMore: () => void;
	onLeadClick: (leadId: Id<"leads">) => void;
}

type SortKey = "name" | "email" | "status" | "opportunities" | "meetings";

export function LeadsTable({
	leads,
	isSearching,
	isLoading,
	canLoadMore,
	onLoadMore,
	onLeadClick,
}: LeadsTableProps) {
	const comparators = useMemo(
		() => ({
			name: (a: LeadRow, b: LeadRow) =>
				(a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
			email: (a: LeadRow, b: LeadRow) => a.email.localeCompare(b.email),
			status: (a: LeadRow, b: LeadRow) =>
				(a.status ?? "active").localeCompare(b.status ?? "active"),
			meetings: (a: LeadRow, b: LeadRow) =>
				(b.latestMeetingAt ?? 0) - (a.latestMeetingAt ?? 0),
			opportunities: (a: LeadRow, b: LeadRow) =>
				(b.opportunityCount ?? 0) - (a.opportunityCount ?? 0),
		}),
		[],
	);

	const { sorted, sort, toggle } = useTableSort<LeadRow, SortKey>(
		leads,
		comparators,
	);

	// Empty state
	if (!isLoading && leads.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						{isSearching ? <SearchIcon /> : <InboxIcon />}
					</EmptyMedia>
					<EmptyTitle>
						{isSearching ? "No leads found" : "No leads yet"}
					</EmptyTitle>
					<EmptyDescription>
						{isSearching
							? "Try adjusting your search term or filters."
							: "Leads will appear here as new bookings come in through Calendly."}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div>
			<div className="overflow-hidden rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<SortableHeader
								label="Name"
								sortKey="name"
								sort={sort}
								onToggle={toggle}
							/>
							<SortableHeader
								label="Email"
								sortKey="email"
								sort={sort}
								onToggle={toggle}
							/>
							<TableHead className="hidden md:table-cell">Social</TableHead>
							<SortableHeader
								label="Status"
								sortKey="status"
								sort={sort}
								onToggle={toggle}
							/>
							<SortableHeader
								label="Opportunities"
								sortKey="opportunities"
								sort={sort}
								onToggle={toggle}
								className="text-right"
							/>
							<SortableHeader
								label="Last Meeting"
								sortKey="meetings"
								sort={sort}
								onToggle={toggle}
								className="hidden lg:table-cell"
							/>
							<TableHead className="hidden lg:table-cell">Closer</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.map((lead) => (
							<TableRow
								key={lead._id}
								className="cursor-pointer hover:bg-muted/50"
								onClick={() => onLeadClick(lead._id)}
							>
								<TableCell className="font-medium">
									{lead.fullName ?? "\u2014"}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{lead.email}
								</TableCell>
								<TableCell className="hidden md:table-cell">
									{lead.socialHandles && lead.socialHandles.length > 0 ? (
										<span className="text-xs text-muted-foreground">
											{lead.socialHandles
												.map((s) => `@${s.handle}`)
												.join(", ")}
										</span>
									) : (
										<span className="text-muted-foreground">{"\u2014"}</span>
									)}
								</TableCell>
								<TableCell>
									<LeadStatusBadge status={lead.status ?? "active"} />
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{lead.opportunityCount ?? 0}
								</TableCell>
								<TableCell className="hidden text-muted-foreground lg:table-cell">
									{lead.latestMeetingAt
										? format(new Date(lead.latestMeetingAt), "MMM d, yyyy")
										: "\u2014"}
								</TableCell>
								<TableCell className="hidden text-muted-foreground lg:table-cell">
									{lead.assignedCloserName ?? "\u2014"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>

			{canLoadMore && (
				<div className="flex justify-center py-4">
					<Button variant="outline" size="sm" onClick={onLoadMore}>
						Load more
					</Button>
				</div>
			)}
		</div>
	);
}
