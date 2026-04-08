"use client";

import { useCallback, useState, Suspense } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusTabs } from "./status-tabs";
import { OpportunityTable } from "./opportunity-table";
import { CloserEmptyState } from "../../_components/closer-empty-state";
import { Button } from "@/components/ui/button";
import { KanbanIcon } from "lucide-react";
import {
	isValidOpportunityStatus,
	type OpportunityStatus,
} from "@/lib/status-config";
import posthog from "posthog-js";

export function CloserPipelinePageClient() {
	return (
		<Suspense fallback={<PageHeaderSkeleton />}>
			<CloserPipelineContent />
		</Suspense>
	);
}

function CloserPipelineContent() {
	usePageTitle("My Pipeline");
	const searchParams = useSearchParams();
	const pathname = usePathname();

	const statusParam = searchParams.get("status");
	const initialStatus =
		statusParam && isValidOpportunityStatus(statusParam)
			? statusParam
			: undefined;

	const [statusFilter, setStatusFilter] = useState<
		OpportunityStatus | undefined
	>(initialStatus);

	const handleStatusChange = useCallback(
		(status: OpportunityStatus | undefined) => {
			setStatusFilter(status);
			posthog.capture("pipeline_status_filter_changed", {
				status: status ?? "all",
			});
			// Use replaceState instead of router.replace to update the URL
			// without triggering a Next.js navigation (which would re-run the
			// async server component and flash the full-page loading skeleton).
			const params = new URLSearchParams(window.location.search);
			if (status) {
				params.set("status", status);
			} else {
				params.delete("status");
			}
			const qs = params.toString();
			window.history.replaceState(
				null,
				"",
				`${pathname}${qs ? `?${qs}` : ""}`,
			);
		},
		[pathname],
	);

	const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary);

	if (pipelineSummary === undefined) {
		return <PageHeaderSkeleton />;
	}

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h1 className="text-2xl font-bold tracking-tight text-pretty">
					My Pipeline
				</h1>
				<p className="text-sm text-muted-foreground">
					Track your opportunities and meeting outcomes
				</p>
			</div>

			<StatusTabs
				activeStatus={statusFilter}
				counts={pipelineSummary.counts}
				total={pipelineSummary.total}
				onStatusChange={handleStatusChange}
			/>

			<Suspense fallback={<TableSkeleton />}>
				<OpportunitiesTable
					statusFilter={statusFilter}
					onClearFilter={() => handleStatusChange(undefined)}
				/>
			</Suspense>
		</div>
	);
}

function PageHeaderSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-4 w-72" />
			</div>
			<Skeleton className="h-9 w-full rounded-lg" />
		</div>
	);
}

function TableSkeleton() {
	return (
		<div className="flex flex-col gap-1">
			{Array.from({ length: 5 }).map((_, i) => (
				<Skeleton key={i} className="h-14 rounded-md" />
			))}
		</div>
	);
}

function OpportunitiesTable({
	statusFilter,
	onClearFilter,
}: {
	statusFilter: OpportunityStatus | undefined;
	onClearFilter: () => void;
}) {
	const opportunities = useQuery(api.closer.pipeline.listMyOpportunities, {
		statusFilter,
	});

	if (opportunities === undefined) {
		return <TableSkeleton />;
	}

	if (opportunities.length === 0) {
		return (
			<CloserEmptyState
				title={
					statusFilter
						? `No ${statusFilter.replace(/_/g, " ")} opportunities`
						: "No opportunities yet"
				}
				description={
					statusFilter
						? "Try selecting a different status filter above."
						: "Opportunities will appear here when leads book meetings through Calendly."
				}
				icon={KanbanIcon}
			>
				{statusFilter && (
					<Button variant="outline" size="sm" onClick={onClearFilter}>
						Show all opportunities
					</Button>
				)}
			</CloserEmptyState>
		);
	}

	return <OpportunityTable opportunities={opportunities} />;
}
