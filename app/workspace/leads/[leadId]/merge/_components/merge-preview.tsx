"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
	ArrowRightIcon,
	MailIcon,
	PhoneIcon,
	AtSignIcon,
	UserIcon,
	MergeIcon,
	GraduationCapIcon,
} from "lucide-react";
import { EnrollmentStatusBadge } from "@/app/workspace/leads-customers/[leadId]/_components/enrollment-status-badge";

type MergePreviewData = FunctionReturnType<typeof api.leads.queries.getMergePreview>;

function identifierIcon(type: string) {
	switch (type) {
		case "email":
			return <MailIcon className="h-3.5 w-3.5" />;
		case "phone":
			return <PhoneIcon className="h-3.5 w-3.5" />;
		default:
			return <AtSignIcon className="h-3.5 w-3.5" />;
	}
}

/**
 * Determines which source identifiers will move vs which are duplicates.
 * Matches backend logic: compare on `type:value` key.
 */
function classifySourceIdentifiers(
	sourceIdentifiers: Doc<"leadIdentifiers">[],
	targetIdentifiers: Doc<"leadIdentifiers">[],
) {
	const targetKeys = new Set(
		targetIdentifiers.map((id) => `${id.type}:${id.value}`),
	);
	const willMove: Doc<"leadIdentifiers">[] = [];
	const duplicates: Doc<"leadIdentifiers">[] = [];

	for (const identifier of sourceIdentifiers) {
		const key = `${identifier.type}:${identifier.value}`;
		if (targetKeys.has(key)) {
			duplicates.push(identifier);
		} else {
			willMove.push(identifier);
		}
	}

	return { willMove, duplicates };
}

function LeadCard({
	lead,
	identifiers,
	opportunityCount,
	variant,
}: {
	lead: Doc<"leads">;
	identifiers: Doc<"leadIdentifiers">[];
	opportunityCount: number;
	variant: "source" | "target";
}) {
	const isSource = variant === "source";

	return (
		<Card
			className={
				isSource
					? "border-red-300 dark:border-red-700"
					: "border-green-300 dark:border-green-700"
			}
		>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<UserIcon className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">
							{lead.fullName ?? "Unknown"}
						</CardTitle>
						{lead.status === "converted" && (
							<Badge variant="outline">Customer</Badge>
						)}
					</div>
					<Badge
						variant={isSource ? "destructive" : "default"}
						className={
							isSource
								? ""
								: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
						}
					>
						{isSource ? "Will be absorbed" : "Will survive"}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{/* Identifiers */}
				<div className="flex flex-col gap-1.5">
					<span className="text-xs font-medium text-muted-foreground uppercase">
						Identifiers ({identifiers.length})
					</span>
					{identifiers.length === 0 ? (
						<span className="text-sm text-muted-foreground">
							No identifiers
						</span>
					) : (
						<ul className="flex flex-col gap-1">
							{identifiers.map((id) => (
								<li
									key={id._id}
									className="flex items-center gap-2 text-sm"
								>
									{identifierIcon(id.type)}
									<span className="truncate">{id.value}</span>
									<Badge variant="outline" className="text-[10px] px-1.5 py-0">
										{id.type}
									</Badge>
								</li>
							))}
						</ul>
					)}
				</div>

				{/* Opportunity count */}
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<span className="font-medium">{opportunityCount}</span>
					<span>
						{opportunityCount === 1 ? "opportunity" : "opportunities"}
					</span>
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * The programs the merge moves to the target, and the ones both people have,
 * which become one with the status an admin changed most recently
 * (docs/plans/phase-4-customers.md §4.7).
 */
function ProgramsCard({ preview }: { preview: MergePreviewData["preview"] }) {
	const { enrollmentsToMove, enrollmentsToCombine } = preview;
	if (enrollmentsToMove.length === 0 && enrollmentsToCombine.length === 0) {
		return null;
	}
	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<GraduationCapIcon className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Programs</CardTitle>
				</div>
			</CardHeader>
			<CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-2">
					<span className="text-sm font-medium">Programs to transfer</span>
					{enrollmentsToMove.length === 0 ? (
						<span className="text-sm text-muted-foreground">None</span>
					) : (
						<ul className="flex flex-col gap-1.5">
							{enrollmentsToMove.map((enrollment) => (
								<li
									key={enrollment.programId}
									className="flex items-center justify-between gap-2 text-sm"
								>
									<span className="truncate">{enrollment.programName}</span>
									<EnrollmentStatusBadge status={enrollment.status} />
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<span className="text-sm font-medium">Programs both have (combined)</span>
					{enrollmentsToCombine.length === 0 ? (
						<span className="text-sm text-muted-foreground">None</span>
					) : (
						<ul className="flex flex-col gap-1.5">
							{enrollmentsToCombine.map((enrollment) => (
								<li key={enrollment.programId} className="flex flex-col gap-1 text-sm">
									<span className="truncate">{enrollment.programName}</span>
									<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
										<EnrollmentStatusBadge status={enrollment.sourceStatus} />
										<span>and</span>
										<EnrollmentStatusBadge status={enrollment.targetStatus} />
										<ArrowRightIcon className="h-3 w-3" aria-label="become" />
										<EnrollmentStatusBadge status={enrollment.status} />
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function MergePreview({ data }: { data: MergePreviewData }) {
	const { source, target, preview } = data;
	const { willMove, duplicates } = classifySourceIdentifiers(
		source.identifiers,
		target.identifiers,
	);

	return (
		<div className="flex flex-col gap-6">
			{preview.exceedsMergeLimit && (
				<Alert variant="destructive">
					<AlertDescription>
						These two leads have too many opportunities between them to merge in one step.
						Nothing will be merged.
					</AlertDescription>
				</Alert>
			)}

			{/* Side-by-side lead cards */}
			<div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
				<LeadCard
					lead={source.lead}
					identifiers={source.identifiers}
					opportunityCount={source.opportunityCount}
					variant="source"
				/>

				{/* Arrow between cards */}
				<div className="hidden items-center justify-center self-center md:flex">
					<ArrowRightIcon className="h-6 w-6 text-muted-foreground" />
				</div>

				<LeadCard
					lead={target.lead}
					identifiers={target.identifiers}
					opportunityCount={target.opportunityCount}
					variant="target"
				/>
			</div>

			{/* Transfer summary */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<MergeIcon className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Transfer Summary</CardTitle>
					</div>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<span className="text-sm font-medium">
								Identifiers to transfer
							</span>
							<span className="text-2xl font-semibold">
								{preview.identifiersToMove}
							</span>
							{willMove.length > 0 && (
								<ul className="mt-1 flex flex-col gap-0.5">
									{willMove.map((id) => (
										<li
											key={id._id}
											className="flex items-center gap-1.5 text-xs text-muted-foreground"
										>
											{identifierIcon(id.type)}
											<span className="truncate">{id.value}</span>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className="flex flex-col gap-1">
							<span className="text-sm font-medium">
								Duplicate identifiers (skipped)
							</span>
							<span className="text-2xl font-semibold">
								{preview.duplicateIdentifiers}
							</span>
							{duplicates.length > 0 && (
								<ul className="mt-1 flex flex-col gap-0.5">
									{duplicates.map((id) => (
										<li
											key={id._id}
											className="flex items-center gap-1.5 text-xs text-muted-foreground line-through"
										>
											{identifierIcon(id.type)}
											<span className="truncate">{id.value}</span>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className="flex flex-col gap-1">
							<span className="text-sm font-medium">
								Opportunities to transfer
							</span>
							<span className="text-2xl font-semibold">
								{preview.opportunitiesToMove}
							</span>
						</div>

						<div className="flex flex-col gap-1">
							<span className="text-sm font-medium">
								Total opportunities after merge
							</span>
							<span className="text-2xl font-semibold">
								{preview.totalOpportunitiesAfterMerge}
							</span>
						</div>
					</div>
				</CardContent>
			</Card>

			<ProgramsCard preview={preview} />
		</div>
	);
}
