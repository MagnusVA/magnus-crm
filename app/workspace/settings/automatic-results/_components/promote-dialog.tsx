"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ACTION_DIALOG_WIDE,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  DialogNote,
  FACT_FIGURE,
  RecordFact,
  RecordFacts,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { Code } from "@/app/workspace/team/_components/team-ui";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { ageWords, type KindDefinition } from "./automation-kinds";
import { panelCommandSentence } from "./automation-command-words";

/** The confirmation is typed, not clicked: case and outer spaces don't matter. */
function matchesName(typed: string, name: string) {
  return typed.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase();
}

/**
 * Switching a kind to Automatic. Shows the certified sample it rests on and
 * what will happen, and enables the button only once the owner has typed the
 * kind's short name. `promoteKind` checks the certificate again on the server.
 */
export default function PromoteDialog({
  definition,
  sampleId,
  noticeHours,
  onClose,
}: {
  definition: KindDefinition;
  sampleId: Id<"automationSamples">;
  noticeHours: number;
  onClose: () => void;
}) {
  const id = useId();
  const now = useNow();
  const sample = useQuery(api.automation.certificates.getSampleProgress, { sampleId });
  const promoteKind = useMutation(api.automation.certificates.promoteKind);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = matchesName(typed, definition.shortName);
  const ready = sample !== undefined && sample !== null && sample.status === "certified";

  const promote = async () => {
    if (!confirmed || !ready) return;
    setPending(true);
    setError(null);
    try {
      const result = await promoteKind({ kind: definition.kind, sampleId });
      if (!result.ok) {
        setError(panelCommandSentence(result.code));
        return;
      }
      toast.success(`${definition.shortName} now records by itself.`);
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't switch this kind to Automatic."));
    } finally {
      setPending(false);
    }
  };

  const steps = [
    "From now on the CRM records this by itself, marked as recorded automatically.",
    "The first 10 are all checked by a person, then one in five. A check waits at most a business day for the first 10, and a week after that.",
    "One wrong person, wrong deal or false loss sends it back to one tap, and so does a check left past its deadline.",
  ];
  if (definition.source === "payment") {
    steps.push("A wrong amount, type or program sends that product's mapping back to one tap. Other products keep running.");
  }
  if (definition.kind === "refusal_loss") {
    steps.push(`A refusal still waits ${noticeHours} hours after the closer has seen the notice, and anyone can stop it.`);
  }
  steps.push("Every result it records by itself is listed on this page, with Undo while nobody has worked on the deal since.");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className={ACTION_DIALOG_WIDE} showCloseButton={!pending}>
        <ActionDialogHeader
          title={`Let the CRM record “${definition.shortName}” by itself?`}
          description="Nobody taps to confirm these any more. Read the sample below before you switch it on."
          tone="danger"
        />
        <div className="max-h-[60vh] overflow-y-auto">
          {sample === undefined ? (
            <DialogNote>Loading the sample…</DialogNote>
          ) : sample === null ? (
            <DialogNote tone="danger">This sample is no longer available.</DialogNote>
          ) : (
            <RecordFacts>
              <RecordFact label="People">
                <span className={FACT_FIGURE}>{sample.distinctPeople}</span> people, one case each
              </RecordFact>
              <RecordFact label="Graded">
                <span className={FACT_FIGURE}>{sample.correct}</span> of{" "}
                <span className={FACT_FIGURE}>{sample.target}</span> correct ·{" "}
                <span className={FACT_FIGURE}>{sample.wrong}</span> wrong ·{" "}
                <span className={FACT_FIGURE}>{sample.unsureOpen}</span> unsure
              </RecordFact>
              <RecordFact label="Not blind">
                <span className={FACT_FIGURE}>{sample.exposed}</span> graded after seeing the proposal
              </RecordFact>
              <RecordFact label="Oldest case">
                {sample.oldestCaseAt === undefined ? (
                  "Not known"
                ) : (
                  <>
                    <span className={FACT_FIGURE}>{dayTimeFormat.format(sample.oldestCaseAt)}</span>,{" "}
                    {ageWords(sample.oldestCaseAt, now)} ago
                  </>
                )}
              </RecordFact>
              <RecordFact label="Rule version">
                <Code className="break-all">{sample.ruleVersion}</Code>
                <span className="mt-0.5 block text-[13px] text-muted-foreground">
                  The rule and reading version these cases were graded under. If it changes, this kind goes back to one tap.
                </span>
              </RecordFact>
              {definition.source === "payment" ? (
                <RecordFact label="Mappings">
                  <span className={FACT_FIGURE}>{sample.scopeBindingIds.length}</span> product and price mappings
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    Only payments under these mappings are recorded by themselves. Payments under any other mapping still ask.
                  </span>
                </RecordFact>
              ) : null}
            </RecordFacts>
          )}
          {sample && !ready ? (
            <DialogNote tone="warning">This sample is not certified, so it can&apos;t be used to switch on Automatic.</DialogNote>
          ) : null}
          <WhatHappens steps={steps} />
          <div className="flex flex-col gap-1.5 border-b px-4 py-3">
            <label htmlFor={`${id}-confirm`} className="text-[13px] font-medium">
              Type <span className="font-semibold">{definition.shortName}</span> to confirm
            </label>
            <Input
              id={`${id}-confirm`}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              disabled={pending}
              onChange={(event) => setTyped(event.target.value)}
              className="w-full max-w-80"
            />
          </div>
        </div>
        <SubmitError>{error}</SubmitError>
        <ActionDialogFooter aside={confirmed ? null : "The button turns on once the name matches."}>
          <CancelButton onClick={onClose} disabled={pending} />
          <SubmitButton
            type="button"
            danger
            pending={pending}
            pendingLabel="Switching on…"
            disabled={!confirmed || !ready}
            onClick={() => void promote()}
          >
            Switch on Automatic
          </SubmitButton>
        </ActionDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
