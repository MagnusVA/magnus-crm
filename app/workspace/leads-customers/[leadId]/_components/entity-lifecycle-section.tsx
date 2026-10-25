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
import { inactiveDays } from "@/convex/lib/respark/settings";
import { useNow } from "@/hooks/use-now";
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
// touch (CONTEXT.md). The inactive badge and last touch follow the respark
// plan (docs/plans/respark.md §6.3); the badge is worked out at render.
export function EntityLifecycleSection() {
	const { lead, firstTouch, latestTouch, lastTouch, inactiveAfterDays, businessTimeZone } = useEntityDetail();
	const { isAdmin } = useRole();
	const now = useNow();
	const [mode, setMode] = useState<LifecycleChangeMode | null>(null);
	if (lead.status === "merged") {
		return null;
	}
	const inactiveFor = inactiveDays(lead, inactiveAfterDays, now);
	const resparkNotAFit =
		lead.disposition === "not_a_fit" && lead.dispositionSource === "respark";
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
				<SimpleTooltip content={dispositionTooltip(lead.dispositionReason, lead.dispositionSource)}>
					<Badge variant={disposition === "open" ? "secondary" : "outline"}>
						{DISPOSITION_LABELS[disposition]}
					</Badge>
				</SimpleTooltip>
				{inactiveFor !== null ? (
					<SimpleTooltip content={`No touch for ${inactiveAfterDays} days or more`}>
						<Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
							Inactive · {inactiveFor} {inactiveFor === 1 ? "day" : "days"}
						</Badge>
					</SimpleTooltip>
				) : null}
			</div>
			{resparkNotAFit ? (
				<p className="text-xs text-muted-foreground">
					Set in a respark, by a lead generator
					{lead.dispositionSetAt ? `, on ${formatDayMonth(lead.dispositionSetAt, now, businessTimeZone)}` : ""}
				</p>
			) : null}
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
				<div className="contents">
					<dt>
						<MicroLabel>Last touch</MicroLabel>
					</dt>
					<dd className="text-right text-xs tabular-nums">
						{lastTouch ? `${formatDate(lastTouch.occurredAt)} · ${lastTouch.label}` : "Not recorded"}
					</dd>
				</div>
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

const DISPOSITION_SOURCE_LABELS = {
	system: "Set by the CRM",
	admin: "Set by an admin",
	respark: "Set in a respark, by a lead generator",
} as const;

function dispositionTooltip(
	reason: string | undefined,
	source: keyof typeof DISPOSITION_SOURCE_LABELS | undefined,
) {
	const parts = [
		source ? DISPOSITION_SOURCE_LABELS[source] : null,
		reason ? `Reason: ${reason}` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(". ") : "Disposition";
}

// "24 Oct", with the year when it isn't this year, in the business day's
// zone so the server render and the browser agree.
function formatDayMonth(value: number, now: number, timeZone: string) {
	const year = (ms: number) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(ms);
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "short",
		...(year(value) === year(now) ? {} : { year: "numeric" as const }),
		timeZone,
	}).format(value);
}
