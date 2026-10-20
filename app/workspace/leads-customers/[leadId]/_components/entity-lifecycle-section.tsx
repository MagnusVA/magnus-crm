"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { MilestoneIcon } from "lucide-react";
import { TouchLines } from "@/app/workspace/_components/deal-credit-list";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DISPOSITION_LABELS,
	LIFECYCLE_STAGE_LABELS,
	LIFECYCLE_STAGES,
} from "@/convex/leads/lifecycle";
import { SimpleTooltip } from "../../_components/entity-ui-tooltips";
import { useEntityDetail } from "./entity-detail-context";
import { formatDate } from "./entity-detail-formatters";
import { MicroLabel, SectionShell } from "./entity-detail-ui";
import type { LifecycleChangeMode } from "./lifecycle-change-dialog";

const LifecycleChangeDialog = dynamic(() =>
	import("./lifecycle-change-dialog").then((module) => module.LifecycleChangeDialog),
);

// How far the person has ever got, with the date they reached each stage,
// whether the team should keep working them, and their first and latest
// touch (CONTEXT.md).
export function EntityLifecycleSection() {
	const { lead, firstTouch, latestTouch } = useEntityDetail();
	const { isAdmin } = useRole();
	const [mode, setMode] = useState<LifecycleChangeMode | null>(null);
	if (lead.status === "merged") {
		return null;
	}
	const stage = lead.lifecycleStage;
	const disposition = lead.disposition;
	const reached = LIFECYCLE_STAGES.filter(
		(option) => lead.lifecycleStageEnteredAt[option] !== undefined,
	);
	// A customer's stage follows their payments; voiding the payment moves it.
	const canMoveBack = stage !== "prospect" && lead.status !== "converted";

	return (
		<SectionShell
			title="Lifecycle"
			icon={<MilestoneIcon aria-hidden="true" />}
			bodyClassName="flex flex-col gap-3 p-4"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge>{LIFECYCLE_STAGE_LABELS[stage]}</Badge>
				<SimpleTooltip content={lead.dispositionReason ? `Reason: ${lead.dispositionReason}` : "Disposition"}>
					<Badge variant={disposition === "open" ? "secondary" : "outline"}>
						{DISPOSITION_LABELS[disposition]}
					</Badge>
				</SimpleTooltip>
			</div>
			<dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
				{reached.map((option) => (
					<div key={option} className="contents">
						<dt>
							<MicroLabel>{LIFECYCLE_STAGE_LABELS[option]}</MicroLabel>
						</dt>
						<dd className="text-right text-xs tabular-nums">
							{formatDate(lead.lifecycleStageEnteredAt[option])}
						</dd>
					</div>
				))}
			</dl>
			<TouchLines
				className="border-t border-border/60 pt-3"
				firstTouch={firstTouch}
				latestTouch={latestTouch}
				labelClassName="text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground"
			/>
			{isAdmin ? (
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="outline" disabled={!canMoveBack} onClick={() => setMode("move_back")}>
						Move back
					</Button>
					<Button size="sm" variant="outline" onClick={() => setMode("disposition")}>
						Set disposition
					</Button>
				</div>
			) : null}
			{mode ? (
				<LifecycleChangeDialog
					open
					onOpenChange={(open) => {
						if (!open) setMode(null);
					}}
					mode={mode}
					leadId={lead._id}
					stage={stage}
					disposition={disposition}
				/>
			) : null}
		</SectionShell>
	);
}
