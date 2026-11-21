"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { BREAKER_WORDS, ageWords, kindDefinition, type Breaker } from "./automation-kinds";
import { panelCommandSentence } from "./automation-command-words";
import type { ConfirmChange } from "./confirm-change-dialog";

const ConfirmChangeDialog = dynamic(() => import("./confirm-change-dialog"));

/** What each reason asks the owner to check before a reset. */
const CHECK_FIRST: Record<Breaker["reason"], string> = {
  audit_overdue: "Record the waiting check in the audit queue below first; a reset is refused while it is still overdue.",
  wrong_write: "Look at the wrong result in the list of automatic writes below and put it right first.",
  not_my_sale_unanswered: "Answer the closer's “This isn't my sale” in Billing first; a reset is refused while it waits.",
  certificate_lapsed: "The rule changed, so the kind needs a new clean sample. A reset can't bring it back.",
};

/**
 * One banner per kind that went back to one tap: which kind, why, and since
 * when. The owner can reset it behind one confirmation; an admin sees why not.
 * The kind keeps asking until then.
 */
export function BreakerBanners({ breakers, canReset }: { breakers: readonly Breaker[]; canReset: boolean }) {
  const now = useNow();
  const resetBreaker = useMutation(api.automation.breaker.resetBreaker);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  if (!breakers.length) return null;

  const requestReset = (breaker: Breaker) => {
    const name = kindDefinition(breaker.kind).shortName;
    setConfirm({
      title: `Reset ${name}?`,
      description: "It can record by itself again. Check why it stopped first.",
      note: CHECK_FIRST[breaker.reason],
      confirmLabel: "Reset",
      pendingLabel: "Resetting…",
      danger: true,
      run: async () => {
        const result = await resetBreaker({ kind: breaker.kind });
        if (!result.ok) throw new Error(panelCommandSentence(result.code));
        toast.success(`${name} can record by itself again.`);
      },
    });
  };

  return (
    <section aria-label="Kinds that went back to one tap" className={cn(CARD, "border-danger-ink/40")}>
      <ul className="divide-y divide-border">
        {breakers.map((breaker) => {
          const name = kindDefinition(breaker.kind).shortName;
          return (
            <li key={breaker.kind} role="status" className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-[13px] leading-[1.45] font-medium">
                  {name} went back to one tap: {BREAKER_WORDS[breaker.reason]}.
                </p>
                <NoteLine>
                  Since <span className="tabular-nums">{dayTimeFormat.format(breaker.trippedAt)}</span>,{" "}
                  {ageWords(breaker.trippedAt, now)} ago. Each one asks for a tap until it is reset.
                </NoteLine>
                {canReset ? null : <NoteLine>Only the owner can reset this.</NoteLine>}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={!canReset || breaker.reason === "certificate_lapsed"}
                onClick={() => requestReset(breaker)}
              >
                Reset
              </Button>
            </li>
          );
        })}
      </ul>
      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </section>
  );
}
