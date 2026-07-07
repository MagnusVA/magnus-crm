"use client";

import type { ReactNode } from "react";
import {
	BanknoteIcon,
	CalendarIcon,
	FingerprintIcon,
	LayersIcon,
	MegaphoneIcon,
	MessageSquareTextIcon,
	UsersIcon,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Doc } from "@/convex/_generated/dataModel";
import { InitialSourceBadge } from "@/app/workspace/_components/initial-source-badge";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

type LeadDetailOpportunity = Doc<"opportunities"> & {
	closerName: string | null;
	closer: MemberAvatarIdentity | null;
	eventTypeName: string | null;
};

type LeadDetailMeeting = Doc<"meetings"> & {
	opportunityStatus: string;
	closerName: string | null;
	closer: MemberAvatarIdentity | null;
};

type LeadQualificationEvent = {
	_id: string;
	resultKind: string;
	slackUserLabel: string;
	slackUser: MemberAvatarIdentity;
	submittedAt: number;
	opportunityId?: string;
	fullNameSnapshot: string;
	platform: string;
	handleSnapshot: string;
};

interface LeadOverviewTabProps {
	lead: Doc<"leads">;
	identifiers: Doc<"leadIdentifiers">[];
	opportunities: LeadDetailOpportunity[];
	meetings: LeadDetailMeeting[];
	qualificationEvents: LeadQualificationEvent[];
}

const identifierTypeLabels: Record<string, string> = {
	email: "Email",
	phone: "Phone",
	calendly_uri: "Calendly URI",
	name: "Name",
};

const confidenceColors: Record<string, string> = {
	high: "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
	medium:
		"bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
	low: "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
	dateStyle: "medium",
	timeStyle: "short",
});

const INCOME_FORMATTER = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

function formatToken(value: string) {
	return value.replace(/_/g, " ");
}

export function LeadOverviewTab({
	lead,
	identifiers,
	opportunities,
	meetings,
	qualificationEvents,
}: LeadOverviewTabProps) {
	const firstSeenDate = lead.firstSeenAt
		? new Date(lead.firstSeenAt).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			})
		: new Date(lead._creationTime).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
			});

	const stats: Array<{
		label: string;
		value: ReactNode;
		icon: typeof CalendarIcon;
	}> = [
		{
			label: "First Seen",
			value: firstSeenDate,
			icon: CalendarIcon,
		},
		{
			label: "Meetings",
			value: String(meetings.length),
			icon: UsersIcon,
		},
		{
			label: "Opportunities",
			value: String(opportunities.length),
			icon: LayersIcon,
		},
		{
			label: "Identifiers",
			value: String(identifiers.length),
			icon: FingerprintIcon,
		},
		{
			label: "Initial Source",
			value: <InitialSourceBadge source={lead.initialSource ?? null} />,
			icon: MegaphoneIcon,
		},
		{
			label: "Self-Reported Income",
			value: (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="cursor-default tabular-nums">
							{lead.selfReportedIncome === undefined
								? "—"
								: INCOME_FORMATTER.format(lead.selfReportedIncome)}
						</span>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs text-pretty">
						Self-reported by the lead — entered via the DM portal.
					</TooltipContent>
				</Tooltip>
			),
			icon: BanknoteIcon,
		},
	];

	return (
		<div className="flex flex-col gap-6">
			{/* Summary stats */}
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
				{stats.map((stat) => (
					<Card key={stat.label}>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
								<stat.icon className="h-5 w-5 text-muted-foreground" />
							</div>
							<div className="min-w-0">
								<p className="truncate text-sm text-muted-foreground">
									{stat.label}
								</p>
								<div className="text-lg font-semibold">{stat.value}</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Slack qualification context */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<MessageSquareTextIcon className="size-4" aria-hidden="true" />
						Slack Qualifications
					</CardTitle>
					<CardDescription>
						Recent setter submissions attached to this lead
					</CardDescription>
				</CardHeader>
				<CardContent>
					{qualificationEvents.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No Slack qualification attempts recorded.
						</p>
					) : (
						<div className="flex flex-col divide-y">
							{qualificationEvents.slice(0, 5).map((event) => (
								<div
									key={event._id}
									className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="min-w-0">
										<MemberIdentity identity={event.slackUser} />
										<p className="text-xs text-muted-foreground">
											{DATE_TIME_FORMATTER.format(new Date(event.submittedAt))}
										</p>
									</div>
									<div className="flex flex-wrap gap-2">
										<Badge variant="outline" className="capitalize">
											{formatToken(event.resultKind)}
										</Badge>
										<Badge
											variant={event.opportunityId ? "secondary" : "outline"}
										>
											{event.opportunityId ? "Linked" : "Unlinked"}
										</Badge>
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Known identifiers */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Known Identifiers</CardTitle>
					<CardDescription>
						All identifiers linked to this lead across booking events
					</CardDescription>
				</CardHeader>
				<CardContent>
					{identifiers.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No identifiers recorded yet.
						</p>
					) : (
						<div className="divide-y">
							{identifiers.map((identifier) => (
								<div
									key={identifier._id}
									className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
								>
									<div className="flex items-center gap-3">
										<Badge variant="outline" className="text-xs font-medium">
											{identifierTypeLabels[identifier.type] ?? identifier.type}
										</Badge>
										<span className="text-sm font-medium">
											{identifier.value}
										</span>
									</div>
									<div className="flex items-center gap-2">
										{identifier.confidence && (
											<Badge
												variant="outline"
												className={cn(
													"text-xs",
													confidenceColors[identifier.confidence],
												)}
											>
												{identifier.confidence}
											</Badge>
										)}
										{identifier.source && (
											<span className="text-xs text-muted-foreground">
												via {identifier.source}
											</span>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
