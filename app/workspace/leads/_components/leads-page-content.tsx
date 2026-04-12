"use client";

import { useState, useCallback } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DownloadIcon } from "lucide-react";
import { LeadSearchInput } from "./lead-search-input";
import { LeadsTable } from "./leads-table";
import type { Id } from "@/convex/_generated/dataModel";

type StatusFilter = "all" | "active" | "converted" | "merged";

export function LeadsPageContent() {
	const { hasPermission } = useRole();
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [searchTerm, setSearchTerm] = useState("");

	// Paginated list (when not searching)
	const {
		results: paginatedLeads,
		status: paginationStatus,
		loadMore,
	} = usePaginatedQuery(
		api.leads.queries.listLeads,
		searchTerm.trim().length > 0
			? "skip"
			: {
					statusFilter: statusFilter === "all" ? undefined : statusFilter,
				},
		{ initialNumItems: 25 },
	);

	// Search results (when searching)
	const searchResults = useQuery(
		api.leads.queries.searchLeads,
		searchTerm.trim().length > 0
			? {
					searchTerm: searchTerm.trim(),
					statusFilter: statusFilter === "all" ? undefined : statusFilter,
				}
			: "skip",
	);

	const leads =
		searchTerm.trim().length > 0 ? searchResults ?? [] : paginatedLeads;
	const isSearching = searchTerm.trim().length > 0;

	const handleSearchChange = useCallback((term: string) => {
		setSearchTerm(term);
	}, []);

	// Open lead detail in a new browser tab
	const handleLeadClick = useCallback((leadId: Id<"leads">) => {
		window.open(`/workspace/leads/${leadId}`, "_blank");
	}, []);

	return (
		<div className="flex flex-col gap-6">
			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
					<p className="text-sm text-muted-foreground">
						Manage leads, merge duplicates, and track identities.
					</p>
				</div>
				<div className="flex items-center gap-2">
					{hasPermission("lead:export") && (
						<Button variant="outline" size="sm" disabled title="Coming soon">
							<DownloadIcon data-icon="inline-start" />
							Export CSV
						</Button>
					)}
				</div>
			</div>

			{/* Search + Filters */}
			<Card className="p-4">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<LeadSearchInput value={searchTerm} onChange={handleSearchChange} />
					<Tabs
						value={statusFilter}
						onValueChange={(val) => setStatusFilter(val as StatusFilter)}
					>
						<TabsList>
							<TabsTrigger value="all">All</TabsTrigger>
							<TabsTrigger value="active">Active</TabsTrigger>
							<TabsTrigger value="converted">Converted</TabsTrigger>
							<TabsTrigger value="merged">Merged</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			</Card>

			{/* Lead Table — row clicks open a new tab */}
			<LeadsTable
				leads={leads}
				isSearching={isSearching}
				isLoading={paginationStatus === "LoadingFirstPage"}
				canLoadMore={!isSearching && paginationStatus === "CanLoadMore"}
				onLoadMore={() => loadMore(25)}
				onLeadClick={handleLeadClick}
			/>
		</div>
	);
}
