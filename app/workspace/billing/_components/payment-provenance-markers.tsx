"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { BotIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clientDisplayName } from "@/lib/agentClient";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import { FIGURE } from "./billing-format";
import { PaidAt } from "./paid-at";

// Billing's two markers (docs/plans/closer-assistant.md §7): a payment an
// agent logged names its client, and a payment whose proof file also backs
// another payment warns the reviewer, with links to the others.

type BillingPaymentDetail = NonNullable<FunctionReturnType<typeof api.billing.queries.getPaymentDetail>>;

export const REUSED_PROOF_MESSAGE = "This proof file also backs another payment";

/** "VIA CLAUDE" as a condensed chip for a payment an agent logged; nothing for the web. */
export function AgentPaymentChip({
  recordedVia,
  agentClient,
  className,
}: {
  recordedVia: "web" | "mcp" | null;
  agentClient: string | null;
  className?: string;
}) {
  if (recordedVia !== "mcp") return null;
  const name = clientDisplayName(agentClient ?? undefined);
  return (
    <span
      title={`Logged through ${name}`}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] bg-muted px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
    >
      <BotIcon aria-hidden="true" className="size-3" />
      via {name}
    </span>
  );
}

/** The queue's amber icon for a payment flagged as reusing a proof file. */
export function ReusedProofIcon({ proofReused }: { proofReused: boolean }) {
  if (!proofReused) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={REUSED_PROOF_MESSAGE}
          className="relative z-10 inline-flex size-6 items-center justify-center rounded-sm text-warning-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CopyIcon aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{REUSED_PROOF_MESSAGE}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The review page's card for a proof file that backs other payments: one
 * ruled row per payment, each a link. Renders nothing otherwise.
 */
export function ReusedProofCard({ detail, now }: { detail: BillingPaymentDetail; now: number }) {
  const matches = detail.proofMatches;
  if (!detail.payment.proofReused && matches.length === 0) return null;
  return (
    <DetailCard
      title="Proof reused"
      meta={<span className="font-condensed text-[13px] font-bold tracking-[0.08em] text-warning-ink uppercase">Check</span>}
    >
      <p className="border-b px-4 py-2.5 text-[13px] leading-[1.45] text-warning-ink" role="status">
        {REUSED_PROOF_MESSAGE}. Compare them before you mark this one reviewed.
      </p>
      {matches.length === 0 ? (
        <p className="px-4 py-2.5 text-[13px] text-muted-foreground">The other payment is no longer in Billing.</p>
      ) : (
        <ul>
          {matches.map((match) => (
            <li key={match.id} className="relative flex min-h-11 items-center gap-3 border-b px-4 py-1.5 last:border-b-0 hover:bg-muted/60">
              <span className={cn(FIGURE, "shrink-0")}>{formatAmountMinor(match.amountMinor, match.currency)}</span>
              <Link
                href={`/workspace/billing/${match.id}`}
                className="min-w-0 flex-1 truncate font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
              >
                {match.programName}
              </Link>
              <span className={cn(FIGURE, "shrink-0 text-muted-foreground")}><PaidAt at={match.recordedAt} now={now} /></span>
              <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
    </DetailCard>
  );
}
