"use client";

import Link from "next/link";
import type { ListDeal } from "@/convex/leadCustomers/listDeal";
import type { LeadCustomerListRowDto } from "@/convex/leadCustomers/types";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { formatCash, resolveNextStep } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import {
	ROW_LINK,
	StageWord,
	StepWords,
} from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { CELL, ROW_GRID } from "./person-row-grid";
import { formatPhone } from "@/lib/phone";

// One person as a ruled two-line row: who, their deal, what happens next,
// and money.

/** A next-step fact in condensed figures, as the person deal card's footer sets it. */
const FACT = "font-condensed text-[15px] font-semibold tracking-[0.02em] tabular-nums";
/** The fact's verb ("Call", "Call back") in plain medium slate, ahead of the figure. */
const VERB = "font-sans text-sm font-medium tracking-normal text-muted-foreground";
/** What the viewer owes on a deal they can act on. */
const FLAG =
	"inline-flex h-5 shrink-0 items-center rounded-[4px] bg-warning-surface px-1.5 text-[13px] font-semibold whitespace-nowrap text-warning-ink";
const META = "truncate text-[13px] text-muted-foreground";

type Clock = { now: number; setting: BusinessDaySetting };

export function PersonRow({ row, now, setting }: { row: LeadCustomerListRowDto } & Clock) {
	const name = personName(row);
	return (
		<li className={cn(ROW_GRID, "relative border-t first:border-t-0 hover:bg-accent/60")}>
			<div className={CELL.person}>
				<Link
					href={
						row.selectedOpportunityId
							? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.selectedOpportunityId}`
							: `/workspace/leads-customers/${row.leadId}`
					}
					className={cn(ROW_LINK, "block truncate text-[15px] leading-5 font-semibold")}
					translate="no"
				>
					{name}
				</Link>
				<ContactLine row={row} name={name} />
			</div>
			<div className={CELL.money}>
				<PaidFigure row={row} />
				<LifecycleWord row={row} now={now} setting={setting} />
			</div>
			<div className={CELL.deal}>
				<DealCell deal={row.deal ?? null} />
			</div>
			<div className={CELL.next}>
				{row.deal ? <NextStepLine deal={row.deal} now={now} setting={setting} /> : null}
				<p className={META}>Last activity {personDate(row.latestActivityAt, setting, now)}</p>
			</div>
		</li>
	);
}

function personName(row: LeadCustomerListRowDto) {
	return (
		row.displayName.trim() ||
		row.email ||
		row.phone ||
		row.primaryIdentifier ||
		"Unnamed person"
	);
}

/** The phone in condensed figures and the email; else the handle. */
function ContactLine({ row, name }: { row: LeadCustomerListRowDto; name: string }) {
	const email = row.email && row.email !== name ? row.email : null;
	const handle =
		!row.phone && !email && row.primaryIdentifier && row.primaryIdentifier !== name
			? row.primaryIdentifier
			: null;
	if (!row.phone && !email && !handle) {
		// The name may already be the email.
		return <p className={META}>{row.email ? "No phone on file" : "No phone or email on file"}</p>;
	}
	return (
		<p className={META} translate="no">
			{row.phone ? (
				<span className="font-condensed text-sm tracking-[0.02em] tabular-nums">{formatPhone(row.phone)}</span>
			) : null}
			{row.phone && email ? " · " : null}
			{email ?? handle}
		</p>
	);
}

/** The program and its stage word, then whose deal it is. */
function DealCell({ deal }: { deal: ListDeal | null }) {
	if (deal === null) {
		return <p className="truncate text-muted-foreground">No deal yet</p>;
	}
	const owner = deal.isMine
		? "Your deal"
		: deal.closerName
			? `Deal of ${deal.closerName}`
			: "No closer";
	return (
		<>
			<p className="flex min-w-0 items-baseline gap-1.5 leading-5">
				<span className={cn("truncate", deal.programName === null && "text-muted-foreground")}>
					{deal.programName ?? "No program"}
				</span>
				<StageWord position={deal.position} systemLoss={deal.systemLoss} className="shrink-0" />
			</p>
			<p className={META}>
				{owner}
				{deal.otherOpenCount > 0 ? ` · +${deal.otherOpenCount} open` : ""}
			</p>
		</>
	);
}

/**
 * The deal's next step as of `now`, by My Pipeline's resolver: an upcoming
 * call, else the open task, else a call that passed with no result, else
 * none. The last two are amber only on a deal the viewer can act on.
 */
function NextStepLine({ deal, now, setting }: { deal: ListDeal } & Clock) {
	if (deal.nextStep === null) {
		return <p className="truncate leading-5 text-muted-foreground">No open deal</p>;
	}
	const { step, missedCallAt } = resolveNextStep(deal.nextStep, now);

	if (step?.kind === "link") {
		return (
			<p className={cn(FACT, "truncate leading-5")}>
				<span className={VERB}>{step.reschedule ? "Reschedule link sent" : "Link sent"}</span>{" "}
				{personDate(step.sentAt, setting, now)}
			</p>
		);
	}
	if (step !== null) {
		return (
			<p className={cn(FACT, "truncate leading-5")}>
				<StepWords step={step} now={now} setting={setting} verbClassName={VERB} />
			</p>
		);
	}

	const word = missedCallAt === null ? "No next step" : "Not recorded";
	const detail = missedCallAt === null ? null : `${personDate(missedCallAt, setting, now)} call`;
	if (!deal.canAct) {
		return (
			<p className="truncate leading-5 text-muted-foreground">
				{word}
				{detail ? ` · ${detail}` : ""}
			</p>
		);
	}
	return (
		<p className="flex min-w-0 items-center gap-1.5">
			<span className={FLAG}>{word}</span>
			{detail ? <span className={META}>· {detail}</span> : null}
		</p>
	);
}

/**
 * What the person has paid, in the one currency it was paid in. Payments in
 * several currencies have no single figure, so none is shown (DESIGN.md, The
 * Separate Currencies Rule); nothing paid is a quiet dash.
 */
function PaidFigure({ row }: { row: LeadCustomerListRowDto }) {
	const paid = row.totalPaidMinor ?? 0;
	if (paid > 0 && row.paymentCurrency) {
		return (
			<p className="truncate font-condensed text-xl leading-6 font-semibold tabular-nums">
				{formatCash(paid, row.paymentCurrency)}
			</p>
		);
	}
	if (paid > 0) {
		return <p className="truncate text-[13px] leading-6 text-muted-foreground">Several currencies</p>;
	}
	return (
		<p className="font-condensed text-xl leading-6 font-semibold text-muted-foreground">
			<span aria-hidden="true">—</span>
			<span className="sr-only">Nothing paid</span>
		</p>
	);
}

/** LEAD and PROSPECT in slate; CUSTOMER SINCE {day} in lime ink. */
function LifecycleWord({ row, now, setting }: { row: LeadCustomerListRowDto } & Clock) {
	const isCustomer = row.lifecycle === "customer";
	const word = isCustomer
		? row.convertedAt
			? `Customer since ${personDate(row.convertedAt, setting, now)}`
			: "Customer"
		: row.lifecycle === "prospect"
			? "Prospect"
			: "Lead";
	return (
		<p
			className={cn(
				"truncate font-condensed text-[11px] leading-4 font-bold tracking-[0.12em] uppercase",
				isCustomer ? "text-primary-ink" : "text-muted-foreground",
			)}
		>
			{word}
		</p>
	);
}
