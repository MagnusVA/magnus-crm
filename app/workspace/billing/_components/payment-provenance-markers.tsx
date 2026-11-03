"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { BotIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { clientDisplayName } from "@/lib/agentClient";
import { formatAmountMinor } from "@/lib/format-currency";

// Billing's two markers (docs/plans/closer-assistant.md §7): a payment an
// agent logged names its client, and a payment whose proof file also backs
// another payment warns the reviewer, with links to the others.

type BillingPaymentDetail = NonNullable<
	FunctionReturnType<typeof api.billing.queries.getPaymentDetail>
>;

export const REUSED_PROOF_MESSAGE =
	"This proof file also backs another payment";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
});

/** "via Claude" for a payment an agent logged; nothing for the web. */
export function AgentPaymentChip({
	recordedVia,
	agentClient,
}: {
	recordedVia: "web" | "mcp" | null;
	agentClient: string | null;
}) {
	if (recordedVia !== "mcp") return null;
	const name = clientDisplayName(agentClient ?? undefined);
	return (
		<Badge variant="outline" className="gap-1 font-normal">
			<BotIcon aria-hidden="true" />
			via {name}
		</Badge>
	);
}

/** The queue's icon for a payment flagged as reusing a proof file. */
export function ReusedProofIcon({ proofReused }: { proofReused: boolean }) {
	if (!proofReused) return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					aria-label={REUSED_PROOF_MESSAGE}
					className="inline-flex text-amber-600 dark:text-amber-400"
					tabIndex={0}
				>
					<CopyIcon aria-hidden="true" />
				</span>
			</TooltipTrigger>
			<TooltipContent>{REUSED_PROOF_MESSAGE}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The review page's line under the summary: how the payment was entered,
 * and the other payments its proof file backs. Renders nothing for a web
 * payment with its own proof.
 */
export function PaymentProvenanceNotice({
	detail,
}: {
	detail: BillingPaymentDetail;
}) {
	const { recordedVia, agentClient, proofReused } = detail.payment;
	const matches = detail.proofMatches;
	const showsReuse = proofReused || matches.length > 0;
	if (recordedVia !== "mcp" && !showsReuse) return null;

	return (
		<div className="flex flex-col gap-3 pb-2">
			{recordedVia === "mcp" ? (
				<p className="flex items-center gap-2 text-sm text-muted-foreground">
					<AgentPaymentChip
						recordedVia={recordedVia}
						agentClient={agentClient}
					/>
					The closer logged this payment through their AI assistant.
				</p>
			) : null}
			{showsReuse ? (
				<Alert className="border-amber-500/40 text-amber-900 dark:text-amber-200">
					<TriangleAlertIcon aria-hidden="true" />
					<AlertTitle>{REUSED_PROOF_MESSAGE}</AlertTitle>
					<AlertDescription>
						{matches.length === 0 ? (
							"The other payment is no longer in Billing."
						) : (
							<ul className="flex flex-col gap-1">
								{matches.map((match) => (
									<li key={match.id}>
										<Link
											className="underline underline-offset-4"
											href={`/workspace/billing/${match.id}`}
										>
											{formatAmountMinor(match.amountMinor, match.currency)}{" "}
											· {match.programName} ·{" "}
											{dateFormatter.format(new Date(match.recordedAt))}
										</Link>
									</li>
								))}
							</ul>
						)}
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	);
}
