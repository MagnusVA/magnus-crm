"use client";

import {
	DealStageTrack,
	TOUCH_CHANNEL_LABELS,
	dealCreditParts,
} from "@/app/workspace/_components/deal-stage-track";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { AddOpportunityPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/add-opportunity-payment-dialog";
import {
	formatDealDate,
	formatDealDateTime,
} from "@/app/workspace/opportunities/[opportunityId]/_components/deal-format";
import { OpportunityMeetingsList } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list";
import {
	DealPaidTotals,
	OpportunityPaymentsList,
	dealPaidTotals,
} from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list";
import { SYSTEM_LOSS_REASON_LABELS } from "@/convex/opportunities/stages";
import type { AttributionTouch } from "@/convex/lib/attribution/detailPayload";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { meetingAttendanceDisplay } from "@/lib/status-config";
import { DealModalHeader } from "./deal-modal-header";
import { DealModalNextStep } from "./deal-modal-next-step";
import { DealModalSection, DealModalTextBlock } from "./deal-modal-section";
import type { DealModalDetail } from "./deal-modal-types";
import { meetingBasePathForRole } from "./meeting-link-utils";

/**
 * The deal modal's content: the header, then one scrolling column of ruled
 * sections. The stage track and credit, the next step with the deal's
 * actions (open deals), the lost reason, calls, payments, notes, and the
 * few facts not shown elsewhere. History lives on the person page, so the
 * modal has no activity feed.
 */
export function DealModalBody({
	detail,
	onDeleted,
}: {
	detail: DealModalDetail;
	onDeleted: () => void;
}) {
	const now = useNow();
	const { setting } = useBusinessDay();
	const { opportunity, closer, attribution, permissions } = detail;
	const timeZone = setting.timeZone;
	const meetingBasePath = meetingBasePathForRole(permissions.viewerRole);

	const title =
		opportunity.soldProgramName ??
		opportunity.firstBookingProgramName ??
		attribution.soldProgram?.name ??
		attribution.bookedProgram?.name ??
		"Deal";
	const closerName = closer ? (closer.fullName ?? closer.email) : null;

	// A call that ended with no result is recorded on its meeting page first.
	const unrecorded = detail.meetings.find(
		(meeting) => meetingAttendanceDisplay(meeting, now) === "not_recorded",
	);
	const recordOutcomeHref = unrecorded ? `${meetingBasePath}/${unrecorded._id}` : null;

	const paidTotals = dealPaidTotals(detail.payments);
	const isWon = opportunity.position === "won";
	const isLost = opportunity.position === "lost";
	const lostReason = opportunity.systemLoss
		? SYSTEM_LOSS_REASON_LABELS[opportunity.systemLoss]
		: opportunity.lostReason?.trim() || null;

	return (
		<>
			<DealModalHeader
				title={title}
				position={opportunity.position}
				systemLoss={opportunity.systemLoss}
				closerName={closerName}
				createdAt={opportunity.createdAt}
				source={opportunity.source}
				setting={setting}
				now={now}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<DealStageTrack
					position={opportunity.position}
					systemLoss={opportunity.systemLoss}
					className="px-3 pt-4 sm:px-5"
				/>
				<DealModalCreditLine detail={detail} />

				<DealModalNextStep
					detail={detail}
					now={now}
					setting={setting}
					recordOutcomeHref={recordOutcomeHref}
					onDeleted={onDeleted}
				/>

				{isLost ? (
					<DealModalTextBlock
						title="Lost reason"
						meta={
							opportunity.lostAt ? (
								<>
									Closed{" "}
									<span className="font-condensed text-sm tabular-nums">
										{formatDealDate(opportunity.lostAt, setting, now)}
									</span>
								</>
							) : null
						}
						className={lostReason ? "text-danger-ink" : "text-muted-foreground"}
					>
						{/* A reason the system wrote shows by name; a person's text
						    shows as written. */}
						{lostReason ?? "No reason was given."}
					</DealModalTextBlock>
				) : null}

				<DealModalSection
					title="Calls"
					meta={
						detail.meetings.length > 0 ? (
							<span className="font-condensed text-sm tabular-nums">
								{detail.meetings.length}
							</span>
						) : null
					}
				>
					{detail.meetings.length === 0 ? (
						<SectionEmpty
							className="py-3 sm:px-5"
							title="No calls on this deal."
						>
							{opportunity.source === "side_deal"
								? "A side deal is logged without a booked call."
								: null}
						</SectionEmpty>
					) : (
						<OpportunityMeetingsList
							meetings={detail.meetings}
							meetingBasePath={meetingBasePath}
							now={now}
							timeZone={timeZone}
						/>
					)}
				</DealModalSection>

				<DealModalSection title="Payments" meta={<DealPaidTotals totals={paidTotals} />}>
					{detail.payments.length === 0 ? (
						<SectionEmpty className="py-3 sm:px-5" title="No payments yet." />
					) : (
						<OpportunityPaymentsList
							payments={detail.payments}
							setting={setting}
							now={now}
							voidablePaymentId={
								permissions.canVoidPayment ? permissions.voidablePaymentId : null
							}
						/>
					)}
					{isWon && permissions.canRecordAdditionalPayment ? (
						<div className="flex min-h-10 items-center justify-between gap-3 border-t px-4 py-2 sm:px-5">
							<span className="text-[0.8125rem] text-muted-foreground">
								Another payment on this program
							</span>
							<AddOpportunityPaymentDialog
								opportunityId={opportunity._id}
								programName={permissions.additionalPaymentProgramName}
							/>
						</div>
					) : null}
				</DealModalSection>

				{opportunity.notes?.trim() ? (
					<DealModalTextBlock title="Notes">{opportunity.notes}</DealModalTextBlock>
				) : null}

				<DealModalDetails detail={detail} setting={setting} now={now} />
			</div>
		</>
	);
}

/**
 * "Lead gen **Ana** · Closer **Bo**", the credit shown once in the modal,
 * with the Slack qualifier named when the deal came through Slack.
 */
function DealModalCreditLine({ detail }: { detail: DealModalDetail }) {
	const parts = dealCreditParts({
		dealAttribution: detail.attribution,
		assignedCloser: detail.closer,
	});
	const slack = detail.attribution.slackQualification;
	if (slack) {
		parts.push({ key: "slack", role: "Slack qualifier", name: slack.slackUserLabel });
	}
	return (
		<p className="px-4 pt-2 pb-3.5 text-[0.8125rem] leading-relaxed text-muted-foreground sm:px-5">
			{parts.length === 0
				? "No credit recorded on this deal."
				: parts.map((part, index) => (
						<span key={part.key}>
							{index > 0 ? " · " : null}
							{part.role}{" "}
							<b className="font-semibold text-foreground" translate="no">
								{part.name}
							</b>
						</span>
					))}
		</p>
	);
}

function touchWords(touch: AttributionTouch, setting: BusinessDaySetting, now: number) {
	return (
		<>
			{TOUCH_CHANNEL_LABELS[touch.channel]}
			{touch.teamMemberName ? (
				<>
					{" · "}
					<span translate="no">{touch.teamMemberName}</span>
				</>
			) : null}
			{" · "}
			<DateFigure>{formatDealDate(touch.occurredAt, setting, now)}</DateFigure>
		</>
	);
}

function DateFigure({ children }: { children: React.ReactNode }) {
	return <span className="font-condensed text-[0.9375rem] tabular-nums">{children}</span>;
}

/**
 * The facts not shown elsewhere, as one ruled list: the booked program
 * beside the sold one when they differ, when the deal was first booked and
 * paid, and its first and latest touch.
 */
function DealModalDetails({
	detail,
	setting,
	now,
}: {
	detail: DealModalDetail;
	setting: BusinessDaySetting;
	now: number;
}) {
	const timeZone = setting.timeZone;
	const { opportunity, attribution } = detail;
	const booked = opportunity.firstBookingProgramName ?? attribution.bookedProgram?.name ?? null;
	const sold = opportunity.soldProgramName ?? attribution.soldProgram?.name ?? null;
	const firstBookedAt = attribution.timeline.firstBookedAt;
	const paidAt = opportunity.paymentReceivedAt ?? attribution.timeline.paymentReceivedAt;
	const firstTouch = attribution.firstTouch;
	const latestTouch =
		attribution.latestTouch && attribution.latestTouch.eventId !== firstTouch?.eventId
			? attribution.latestTouch
			: null;

	const rows: Array<{ label: string; value: React.ReactNode }> = [];
	if (booked && sold && booked !== sold) {
		rows.push({ label: "Booked program", value: <span translate="no">{booked}</span> });
		rows.push({ label: "Sold program", value: <span translate="no">{sold}</span> });
	}
	if (firstBookedAt) {
		rows.push({
			label: "First booked",
			value: <DateFigure>{formatDealDateTime(firstBookedAt, timeZone, now)}</DateFigure>,
		});
	}
	if (paidAt) {
		rows.push({
			label: "Payment received",
			value: <DateFigure>{formatDealDateTime(paidAt, timeZone, now)}</DateFigure>,
		});
	}
	if (firstTouch) {
		rows.push({ label: "First touch", value: touchWords(firstTouch, setting, now) });
	}
	if (latestTouch) {
		rows.push({ label: "Latest touch", value: touchWords(latestTouch, setting, now) });
	}
	if (rows.length === 0) return null;

	return (
		<DealModalSection title="Details">
			<dl>
				{rows.map((row) => (
					<div
						key={row.label}
						className="grid min-h-9 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] border-t px-4 py-1.5 first:border-t-0 sm:px-5"
					>
						<dt className="text-[0.8125rem] text-muted-foreground">{row.label}</dt>
						<dd className="min-w-0 text-sm wrap-break-word">{row.value}</dd>
					</div>
				))}
			</dl>
		</DealModalSection>
	);
}
