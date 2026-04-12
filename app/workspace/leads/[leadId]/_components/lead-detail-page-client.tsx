"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { usePageTitle } from "@/hooks/use-page-title";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	ArrowLeftIcon,
	EditIcon,
	MergeIcon,
	UserCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { LeadStatusBadge } from "../../_components/lead-status-badge";
import { PotentialDuplicateBanner } from "@/app/workspace/closer/meetings/_components/potential-duplicate-banner";
import { LeadOverviewTab } from "./tabs/lead-overview-tab";
import { LeadMeetingsTab } from "./tabs/lead-meetings-tab";
import { LeadOpportunitiesTab } from "./tabs/lead-opportunities-tab";
import { LeadActivityTab } from "./tabs/lead-activity-tab";
import { LeadCustomFieldsTab } from "./tabs/lead-custom-fields-tab";
import type { Id } from "@/convex/_generated/dataModel";

export function LeadDetailPageClient() {
	const params = useParams<{ leadId: string }>();
	const router = useRouter();
	const { hasPermission } = useRole();
	const [activeTab, setActiveTab] = useState("overview");

	const leadId = params.leadId as Id<"leads">;

	const detail = useQuery(api.leads.queries.getLeadDetail, { leadId });

	usePageTitle(
		detail?.lead?.fullName ?? detail?.lead?.email ?? "Lead Detail",
	);

	// If the lead was merged, redirect to the active lead's page
	useEffect(() => {
		if (detail?.redirectToLeadId) {
			router.replace(`/workspace/leads/${detail.redirectToLeadId}`);
		}
	}, [detail?.redirectToLeadId, router]);

	const lead = detail?.lead;

	// Loading state -- query is still resolving
	if (!detail) {
		return (
			<div className="flex flex-col gap-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-[400px] w-full" />
			</div>
		);
	}

	// Lead not found or was redirected
	if (!lead) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 py-20">
				<p className="text-muted-foreground">Lead not found.</p>
				<Button variant="outline" asChild>
					<Link href="/workspace/leads">Back to Leads</Link>
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			{/* Back button + status */}
			<div className="flex items-center justify-between">
				<Button variant="ghost" size="sm" asChild>
					<Link href="/workspace/leads">
						<ArrowLeftIcon className="mr-1.5 h-4 w-4" />
						Leads
					</Link>
				</Button>
				<LeadStatusBadge status={lead.status ?? "active"} />
			</div>

			{/* Lead header */}
			<div className="flex flex-col gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">
						{lead.fullName ?? lead.email}
					</h1>
					<div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
						<span>{lead.email}</span>
						{lead.phone && <span>{lead.phone}</span>}
					</div>
				</div>

				{/* Social handles */}
				{lead.socialHandles && lead.socialHandles.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{lead.socialHandles.map(
							(s: { type: string; handle: string }, i: number) => (
								<Badge key={i} variant="secondary" className="text-xs">
									{s.type}: @{s.handle}
								</Badge>
							),
						)}
					</div>
				)}

				{/* Action buttons */}
				<div className="flex flex-wrap gap-2">
					{hasPermission("lead:edit") && (
						<Button variant="outline" size="sm">
							<EditIcon className="mr-1.5 h-3.5 w-3.5" />
							Edit
						</Button>
					)}
					{hasPermission("lead:merge") && (
						<Button variant="outline" size="sm" asChild>
							<Link href={`/workspace/leads/${leadId}/merge`}>
								<MergeIcon className="mr-1.5 h-3.5 w-3.5" />
								Merge Lead
							</Link>
						</Button>
					)}
					{hasPermission("lead:convert") && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="outline" size="sm" disabled>
									<UserCheckIcon className="mr-1.5 h-3.5 w-3.5" />
									Convert to Customer
								</Button>
							</TooltipTrigger>
							<TooltipContent>Coming soon (Feature D)</TooltipContent>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Potential duplicate banners */}
			{detail.potentialDuplicates.map((dup) => (
				<PotentialDuplicateBanner
					key={dup.duplicateLead._id}
					duplicateLead={dup.duplicateLead}
					currentLeadName={lead.fullName}
					opportunityId={dup.opportunityId}
					currentLeadId={lead._id}
				/>
			))}

			{/* Tabbed content */}
			<Tabs value={activeTab} onValueChange={setActiveTab}>
				<TabsList>
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="meetings">
						Meetings ({detail.meetings.length})
					</TabsTrigger>
					<TabsTrigger value="opportunities">
						Opps ({detail.opportunities.length})
					</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="fields">Fields</TabsTrigger>
				</TabsList>

				<TabsContent value="overview">
					<LeadOverviewTab
						lead={lead}
						identifiers={detail.identifiers}
						opportunities={detail.opportunities}
						meetings={detail.meetings}
					/>
				</TabsContent>

				<TabsContent value="meetings">
					<LeadMeetingsTab meetings={detail.meetings} />
				</TabsContent>

				<TabsContent value="opportunities">
					<LeadOpportunitiesTab opportunities={detail.opportunities} />
				</TabsContent>

				<TabsContent value="activity">
					<LeadActivityTab
						meetings={detail.meetings}
						followUps={detail.followUps}
						mergeHistory={detail.mergeHistory}
					/>
				</TabsContent>

				<TabsContent value="fields">
					<LeadCustomFieldsTab lead={lead} meetings={detail.meetings} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
