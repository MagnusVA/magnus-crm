"use client";

import { useMemo } from "react";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SortableHeader } from "@/components/sortable-header";
import { useTableSort } from "@/hooks/use-table-sort";
import { OpportunityRow } from "./opportunity-row";

type Opportunity = {
	_id: string;
	leadName: string;
	leadEmail?: string;
	status: string;
	latestMeetingId?: string;
	latestMeetingAt?: number;
	createdAt: number;
};

type OpportunityTableProps = {
	opportunities: Opportunity[];
	canLoadMore: boolean;
	onLoadMore: () => void;
};

/**
 * Data table for the closer's pipeline.
 *
 * Columns: Lead · Status · Meeting · Created · Actions.
 *
 * Follows web-design-guidelines: `<th>` with proper `scope`, tabular-nums
 * on date columns, keyboard-navigable action buttons.
 */
export function OpportunityTable({
	opportunities,
	canLoadMore,
	onLoadMore,
}: OpportunityTableProps) {
	const comparators = useMemo(
		() => ({
			lead: (a: Opportunity, b: Opportunity) =>
				a.leadName.localeCompare(b.leadName),
			status: (a: Opportunity, b: Opportunity) =>
				a.status.localeCompare(b.status),
			meeting: (a: Opportunity, b: Opportunity) =>
				(a.latestMeetingAt ?? 0) - (b.latestMeetingAt ?? 0),
			created: (a: Opportunity, b: Opportunity) =>
				a.createdAt - b.createdAt,
		}),
		[],
	);

	const { sorted, sort, toggle } = useTableSort(opportunities, comparators);

	return (
		<div className="flex flex-col gap-4">
		<Table>
			<TableHeader>
				<TableRow>
					<SortableHeader
						label="Lead"
						sortKey="lead"
						sort={sort}
						onToggle={toggle}
					/>
					<SortableHeader
						label="Status"
						sortKey="status"
						sort={sort}
						onToggle={toggle}
					/>
					<SortableHeader
						label="Meeting"
						sortKey="meeting"
						sort={sort}
						onToggle={toggle}
					/>
					<SortableHeader
						label="Created"
						sortKey="created"
						sort={sort}
						onToggle={toggle}
					/>
					<TableHead scope="col" className="text-right">
						Actions
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{sorted.map((opp) => (
					<OpportunityRow
						key={opp._id}
						leadName={opp.leadName}
						leadEmail={opp.leadEmail}
						status={opp.status}
						latestMeetingId={opp.latestMeetingId}
						latestMeetingAt={opp.latestMeetingAt}
						createdAt={opp.createdAt}
					/>
				))}
			</TableBody>
		</Table>

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
