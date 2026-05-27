"use client";

import type { FunctionReturnType } from "convex/server";
import { MessageSquareTextIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
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
type SlackContributorEvent =
	BillingPaymentDetail["slackContributorTimeline"][number];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function ContributorDot() {
	return (
		<span
			aria-hidden="true"
			className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-foreground/35 ring-2 ring-background"
		/>
	);
}

export function SlackContributorTimeline({
	events,
}: {
	events: SlackContributorEvent[];
}) {
	if (events.length === 0) {
		return (
			<section
				aria-labelledby="slack-contributors-heading"
				className="min-w-0"
			>
				<header className="flex items-baseline justify-between gap-3">
					<h2
						className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
						id="slack-contributors-heading"
					>
						Slack contributors
					</h2>
				</header>
				<Empty className="mt-4 border-0">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<MessageSquareTextIcon aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No qualification context</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						No linked Slack qualification events were found.
					</EmptyContent>
				</Empty>
			</section>
		);
	}

	return (
		<section aria-labelledby="slack-contributors-heading" className="min-w-0">
			<header className="flex items-baseline justify-between gap-2 pb-1">
				<h2
					className="text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground"
					id="slack-contributors-heading"
				>
					Slack contributors
				</h2>
				<span className="font-mono text-[0.68rem] tabular-nums text-muted-foreground/70">
					{events.length} entr{events.length === 1 ? "y" : "ies"}
				</span>
			</header>

			<ol className="relative">
				<span
					aria-hidden="true"
					className="absolute bottom-2 left-22 top-2 w-px bg-border"
				/>

				{events.map((event) => {
					const date = new Date(event.submittedAt);
					return (
						<li
							className="grid grid-cols-[5.5rem_0.75rem_1fr] gap-x-2 py-1.5"
							key={`${event.slackUserId}-${event.submittedAt}`}
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
								<ContributorDot />
							</div>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
									<span className="text-xs font-medium text-foreground">
										{event.label}
									</span>
									{event.resultKind ? (
										<Badge
											className="h-4 px-1 text-[0.6rem] font-normal uppercase tracking-wide"
											variant="outline"
										>
											{event.resultKind}
										</Badge>
									) : null}
								</div>
								<p className="break-all font-mono text-[0.65rem] text-muted-foreground">
									{event.slackUserId}
								</p>
							</div>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
