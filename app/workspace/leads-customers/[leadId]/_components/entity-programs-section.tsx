"use client";

import { GraduationCapIcon, PanelRightOpenIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import type { EnrollmentStatus } from "@/convex/enrollments/validators";
import { TruncatingTooltip } from "../../_components/entity-ui-tooltips";
import {
	useEntityDetail,
	type EntityDetailEnrollment,
	type EntityDetailOpportunity,
} from "./entity-detail-context";
import {
	formatDate,
	formatPaidTotal,
	formatPaymentCount,
} from "./entity-detail-formatters";
import { MetaDot, MetaRow, SectionShell } from "./entity-detail-ui";
import { EnrollmentStatusBadge } from "./enrollment-status-badge";
import { EnrollmentStatusControl } from "./enrollment-status-control";
import { useOpportunitySheet } from "./opportunity-sheet-context";

const CHANGED_VERB: Record<EnrollmentStatus, string> = {
	active: "Reactivated",
	paused: "Paused",
	churned: "Churned",
};

// One row per program the person bought, with its own status, the deal of its
// first payment and what it has paid (docs/plans/phase-4-customers.md §6.2).
export function EntityProgramsSection() {
	const { enrollments, opportunities } = useEntityDetail();
	const { hasPermission } = useRole();
	if (enrollments.length === 0) return null;

	const dealById = new Map(opportunities.map((item) => [item.opportunity._id, item]));
	const canEdit = hasPermission("customer:edit");

	return (
		<SectionShell
			title="Programs"
			icon={<GraduationCapIcon aria-hidden="true" />}
			count={enrollments.length}
			bodyClassName="divide-y divide-border/60"
		>
			{enrollments.map((enrollment) => (
				<EnrollmentRow
					key={enrollment.enrollmentId}
					enrollment={enrollment}
					deal={dealById.get(enrollment.opportunityId)}
					canEdit={canEdit}
				/>
			))}
		</SectionShell>
	);
}

function EnrollmentRow({
	enrollment,
	deal,
	canEdit,
}: {
	enrollment: EntityDetailEnrollment;
	deal: EntityDetailOpportunity | undefined;
	canEdit: boolean;
}) {
	const {
		actions: { openOpportunity },
	} = useOpportunitySheet();

	return (
		<div className="flex items-start justify-between gap-3 py-3 pr-3 pl-4 transition-colors hover:bg-muted/30">
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					<TruncatingTooltip content={enrollment.programName}>
						<span className="min-w-0 truncate text-sm font-medium" translate="no">
							{enrollment.programName}
						</span>
					</TruncatingTooltip>
					<EnrollmentStatusBadge status={enrollment.status} />
				</div>
				<MetaRow>
					<span className="tabular-nums">Since {formatDate(enrollment.enrolledAt)}</span>
					{/* A closer opens only their own deals. */}
					{deal?.permissions.canOpenOpportunity ? (
						<>
							<MetaDot />
							<button
								type="button"
								onClick={() => openOpportunity(enrollment.opportunityId)}
								className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							>
								<PanelRightOpenIcon className="size-3.5" aria-hidden="true" />
								View deal
							</button>
						</>
					) : null}
				</MetaRow>
				{enrollment.statusChangedAt ? (
					<p className="text-[11px] text-muted-foreground">
						{CHANGED_VERB[enrollment.status]} on{" "}
						<span className="tabular-nums">{formatDate(enrollment.statusChangedAt)}</span> by{" "}
						<span translate="no">{enrollment.statusChangedByName ?? "Removed user"}</span>
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1.5">
				<span className="text-sm font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
					{formatPaidTotal(enrollment)}
				</span>
				<span className="text-[11px] text-muted-foreground tabular-nums">
					{formatPaymentCount(enrollment.paymentCount)}
				</span>
				{canEdit ? <EnrollmentStatusControl enrollment={enrollment} /> : null}
			</div>
		</div>
	);
}
