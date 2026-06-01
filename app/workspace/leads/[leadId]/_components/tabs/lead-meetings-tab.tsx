"use client";

import { useRouter } from "next/navigation";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
	opportunityStatusConfig,
	type OpportunityStatus,
} from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

type LeadDetailMeeting = Doc<"meetings"> & {
	opportunityStatus: string;
	closerName: string | null;
	closer: MemberAvatarIdentity | null;
};

interface LeadMeetingsTabProps {
	meetings: LeadDetailMeeting[];
}

export function LeadMeetingsTab({ meetings }: LeadMeetingsTabProps) {
	const router = useRouter();

	if (meetings.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<p className="text-sm text-muted-foreground">
					No meetings recorded for this lead.
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Date</TableHead>
						<TableHead>Closer</TableHead>
						<TableHead>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{meetings.map((mtg) => {
						const statusCfg =
							opportunityStatusConfig[
								mtg.opportunityStatus as OpportunityStatus
							];

						return (
							<TableRow
								key={mtg._id}
								className="cursor-pointer"
								onClick={() =>
									router.push(`/workspace/closer/meetings/${mtg._id}`)
								}
							>
								<TableCell className="font-medium">
									<time dateTime={new Date(mtg.scheduledAt).toISOString()}>
										{new Date(mtg.scheduledAt).toLocaleDateString("en-US", {
											month: "short",
											day: "numeric",
											year: "numeric",
										})}
									</time>
									<span className="ml-1.5 text-xs text-muted-foreground">
										{new Date(mtg.scheduledAt).toLocaleTimeString("en-US", {
											hour: "numeric",
											minute: "2-digit",
										})}
									</span>
								</TableCell>
								<TableCell>
									{mtg.closer ? (
										<MemberIdentity identity={mtg.closer} />
									) : (
										<span className="text-muted-foreground">Unassigned</span>
									)}
								</TableCell>
								<TableCell>
									{statusCfg ? (
										<Badge
											variant="secondary"
											className={cn("text-xs", statusCfg.badgeClass)}
										>
											{statusCfg.label}
										</Badge>
									) : (
										<Badge variant="outline" className="text-xs">
											{mtg.opportunityStatus}
										</Badge>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
