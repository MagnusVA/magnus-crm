"use client";

import type { FunctionReturnType } from "convex/server";
import { ActivityIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
import { Badge } from "@/components/ui/badge";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";

type BillingPaymentDetail = NonNullable<
	FunctionReturnType<typeof api.billing.queries.getPaymentDetail>
>;
type BillingPaymentEvent = BillingPaymentDetail["events"][number];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function eventDetail(event: BillingPaymentEvent) {
	if (event.eventType === "payment.verified") {
		return "Moved from needs review to reviewed.";
	}
	if (event.fromStatus && event.toStatus) {
		return `${event.fromStatus} → ${event.toStatus}`;
	}
	if (event.toStatus) {
		return `Set to ${event.toStatus}`;
	}
	return event.reason ?? null;
}

function parseEventMetadata(metadata: string | null) {
	if (!metadata) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(metadata);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function formatFieldLabel(key: string) {
	const labels: Record<string, string> = {
		amountMinor: "Amount",
		paymentType: "Payment type",
		programId: "Program ID",
		programName: "Program",
		referenceCode: "Reference",
		note: "Internal note",
	};
	return labels[key] ?? key;
}

function formatValue(key: string, value: unknown) {
	if (value === null || value === undefined || value === "") {
		return "empty";
	}
	if (typeof value === "number") {
		if (key === "amountMinor") {
			return (value / 100).toFixed(2);
		}
		return String(value);
	}
	return String(value);
}

function CorrectionMetadata({
	metadata,
}: {
	metadata: Record<string, unknown>;
}) {
	const entries = Object.entries(metadata).filter(
		([key]) => key !== "returnedToReview",
	);
	if (entries.length === 0) {
		return null;
	}

	return (
		<ul className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2 text-[0.68rem] text-muted-foreground">
			{entries.map(([key, value]) => {
				const change =
					value && typeof value === "object"
						? (value as { from?: unknown; to?: unknown })
						: { from: null, to: value };
				return (
					<li key={key}>
						<span className="font-medium text-foreground">
							{formatFieldLabel(key)}
						</span>
						{": "}
						<span className="font-mono">{formatValue(key, change.from)}</span>
						<span className="text-muted-foreground/60"> → </span>
						<span className="font-mono">{formatValue(key, change.to)}</span>
					</li>
				);
			})}
		</ul>
	);
}

function EventDot() {
	return (
		<span
			aria-hidden="true"
			className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-foreground/35 ring-2 ring-background"
		/>
	);
}

export function BillingEventHistory({
	events,
}: {
	events: BillingPaymentEvent[];
}) {
	if (events.length === 0) {
		return (
			<section aria-labelledby="billing-history-log-heading" className="min-w-0">
				<header className="flex items-baseline justify-between gap-3">
					<h2
						className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
						id="billing-history-log-heading"
					>
						Review audit log
					</h2>
				</header>
				<Empty className="mt-4 border-0">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ActivityIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No review events recorded</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						This payment has no audit events yet.
					</EmptyContent>
				</Empty>
			</section>
		);
	}

	return (
		<section aria-labelledby="billing-history-log-heading" className="min-w-0">
			<header className="flex items-baseline justify-between gap-2 pb-1">
				<h2
					className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
					id="billing-history-log-heading"
				>
					Review audit log
				</h2>
				<span className="font-mono text-[0.68rem] tabular-nums text-muted-foreground/70">
					{events.length} event{events.length === 1 ? "" : "s"}
				</span>
			</header>

			<ol className="relative">
				{/* The thin vertical rule that turns the list into a timeline */}
				<span
					aria-hidden="true"
					className="absolute bottom-2 left-22 top-2 w-px bg-border"
				/>

				{events.map((event) => {
					const label = getEventLabel(event.eventType);
					const detail = eventDetail(event);
					const metadata = parseEventMetadata(event.metadata);
					const date = new Date(event.occurredAt);
					return (
						<li
							className="grid grid-cols-[5.5rem_0.75rem_1fr] gap-x-2 py-1.5"
							key={event.id}
						>
							<time
								className="text-right font-mono text-[0.68rem] leading-tight tabular-nums text-muted-foreground"
								dateTime={date.toISOString()}
							>
								{dateFormatter.format(date)}{" "}
								<span className="text-muted-foreground/65">
									{timeFormatter.format(date)}
								</span>
							</time>
							<div className="flex justify-center">
								<EventDot />
							</div>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
									<span className="text-xs font-medium text-foreground">
										{label.verb}
									</span>
									<Badge
										className="h-4 px-1 text-[0.6rem] font-normal uppercase tracking-wide"
										variant="outline"
									>
										{event.source}
									</Badge>
								</div>
								<div className="flex flex-wrap items-center gap-x-1.5 text-[0.68rem] text-muted-foreground">
									{event.actorName ? (
										<span className="text-foreground/80">
											{event.actorName}
										</span>
									) : null}
									{detail ? <span>{detail}</span> : null}
								</div>
								{event.reason && event.reason !== detail ? (
									<p className="text-[0.68rem] text-muted-foreground">
										{event.reason}
									</p>
								) : null}
								{event.eventType === "payment.corrected" && metadata ? (
									<CorrectionMetadata metadata={metadata} />
								) : null}
							</div>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
