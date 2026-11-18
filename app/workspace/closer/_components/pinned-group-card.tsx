"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { formatAmountMinor } from "@/lib/format-currency";
import { reportClientError } from "@/lib/observability/report-client-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import {
  paymentCommandSentence,
  paymentErrorSentence,
} from "@/app/workspace/_components/payments/payment-command-words";

type PinnedLine = FunctionReturnType<typeof api.closer.pinnedLines.listMyPinnedLines>[number];

/** "$500.00 ", or nothing when the line carries no amount. */
function money(line: PinnedLine) {
  return line.amountMinor !== undefined && line.currency ? `${formatAmountMinor(line.amountMinor, line.currency)} ` : "";
}

/** What changed, in one line: "A $500.00 win was recorded from Whop". Null for a kind this group doesn't show. */
function headline(line: PinnedLine): string | null {
  const amount = money(line);
  switch (line.kind) {
    case "win_recorded_from_whop":
      return `A ${amount}win was recorded from Whop`;
    case "instalment_credited":
      return `A ${amount}payment was added from Whop`;
    case "win_removed":
      return `A ${amount}win was removed`;
    case "payment_removed":
      return `A ${amount}payment was removed`;
    case "payment_restored":
      return `A ${amount}payment was restored`;
    default:
      // Later kinds (call results, refusals) belong to "Waiting on you".
      return null;
  }
}

/** Where a removed win left the deal. */
function positionAfter(line: PinnedLine): string | null {
  if (line.kind !== "win_removed" || !line.dealPositionAfter) return null;
  switch (line.dealPositionAfter) {
    case "follow_up":
      return "The deal is back at Follow-up with a reminder due now.";
    case "booked":
      return "The deal is back at Booked.";
    case "lost":
      return "The deal is closed as lost.";
    default:
      return `The deal is back at ${dealPositionLabel(line.dealPositionAfter)}.`;
  }
}

/**
 * Changes to the closer's numbers that someone else made (a win recorded or
 * removed from Whop, a payment added, removed or restored), each kept until
 * the closer taps Got it. Above Tasks, so eight task rows never bury them.
 * Renders nothing while loading or when there is nothing to show.
 */
export function PinnedGroupCard() {
  const all = useQuery(api.closer.pinnedLines.listMyPinnedLines, {});
  const lines = (all ?? []).filter((line) => headline(line) !== null);
  if (lines.length === 0) return null;

  return (
    <section
      aria-labelledby="pinned-group-title"
      className="rounded-xl border bg-card text-sm text-card-foreground"
    >
      <header className="flex min-h-[46px] items-center gap-2 border-b px-4 py-2">
        <h2 id="pinned-group-title" className="text-[15px] font-semibold">
          Changes to your numbers
        </h2>
        <span className="rounded-full bg-secondary px-[7px] text-xs leading-[18px] font-semibold tabular-nums">
          {lines.length}
        </span>
      </header>
      <ul>
        {lines.map((line) => (
          <PinnedLineRow key={line._id} line={line} />
        ))}
      </ul>
    </section>
  );
}

function PinnedLineRow({ line }: { line: PinnedLine }) {
  const dismiss = useMutation(api.closer.pinnedLines.dismissPinnedLine);
  const [pending, setPending] = useState(false);
  const change = headline(line) ?? "";
  const text = line.personName ? `${line.personName} · ${change}` : change;
  const after = positionAfter(line);

  const gotIt = async (lineId: Id<"closerPinnedLines">) => {
    setPending(true);
    try {
      const result = await dismiss({ lineId });
      if (!result.ok) toast.error(paymentCommandSentence(result.code));
    } catch (error) {
      reportClientError(error, { flow: "dismiss_pinned_line" });
      toast.error(paymentErrorSentence(error, "That didn't save. Please try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-t px-4 py-2.5 first:border-t-0">
      <div className="min-w-0">
        <p>
          <Link
            href={`/workspace/opportunities/${line.opportunityId}`}
            className="font-semibold underline-offset-2 hover:underline focus-visible:underline"
          >
            {text}
          </Link>
        </p>
        {after ? <p className="text-[13px] text-muted-foreground">{after}</p> : null}
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-8 px-3"
        disabled={pending}
        aria-label={`Got it: ${text}`}
        onClick={() => void gotIt(line._id)}
      >
        {pending ? <Spinner data-icon="inline-start" /> : null}
        <TranslatableText>Got it</TranslatableText>
      </Button>
    </li>
  );
}
