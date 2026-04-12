"use client";

import {
	CalendarIcon,
	FingerprintIcon,
	LayersIcon,
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
import { cn } from "@/lib/utils";
import type { Doc } from "@/convex/_generated/dataModel";

type LeadDetailOpportunity = Doc<"opportunities"> & {
	closerName: string | null;
	eventTypeName: string | null;
};

type LeadDetailMeeting = Doc<"meetings"> & {
	opportunityStatus: string;
	closerName: string | null;
};

interface LeadOverviewTabProps {
	lead: Doc<"leads">;
	identifiers: Doc<"leadIdentifiers">[];
	opportunities: LeadDetailOpportunity[];
	meetings: LeadDetailMeeting[];
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

export function LeadOverviewTab({
	lead,
	identifiers,
	opportunities,
	meetings,
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

	const stats = [
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
	];

	return (
		<div className="flex flex-col gap-6">
			{/* Summary stats */}
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				{stats.map((stat) => (
					<Card key={stat.label}>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
								<stat.icon className="h-5 w-5 text-muted-foreground" />
							</div>
							<div>
								<p className="text-sm text-muted-foreground">{stat.label}</p>
								<p className="text-lg font-semibold">{stat.value}</p>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

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
