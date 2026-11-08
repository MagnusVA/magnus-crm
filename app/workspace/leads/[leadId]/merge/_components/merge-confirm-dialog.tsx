"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { LABEL, plural } from "@/app/workspace/team/_components/team-ui";
import { personLabel, splitIdentifiers, type MergePreviewData } from "./merge-format";

/**
 * Merge two people: both records, what will happen, then confirm
 * (DESIGN.md, the tenant delete dialog's pattern). The parent toasts a
 * failure and leaves the dialog open to try again.
 */
export function MergeConfirmDialog({
  open,
  onOpenChange,
  data,
  merging,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: MergePreviewData;
  merging: boolean;
  onConfirm: () => void;
}) {
  const { source, target, preview } = data;
  const sourceName = personLabel(source.lead);
  const targetName = personLabel(target.lead);
  const { moving } = splitIdentifiers(data);
  const programCount = preview.enrollmentsToMove.length + preview.enrollmentsToCombine.length;
  const moves = [
    plural(preview.opportunitiesToMove, "deal"),
    plural(moving.length, "identifier"),
    programCount > 0 ? plural(programCount, "program") : null,
  ].filter(Boolean);

  // What mergeLead does, in its order (convex/leads/merge.ts, executeMerge).
  const steps: ReactNode[] = [
    moving.length > 0 ? `Moves ${sourceName}'s identifiers to ${targetName}, skipping duplicates.` : null,
    `Fills ${targetName}'s empty details from ${sourceName}. Where both have one, ${targetName}'s stays.`,
    `Moves all of ${sourceName}'s deals, calls, payments, tasks, notes and form answers.`,
    programCount > 0 ? `Moves ${sourceName}'s programs, combining any both are in.` : null,
    source.lead.status === "converted" && target.lead.status !== "converted"
      ? `Makes ${targetName} a customer, as ${sourceName} is one.`
      : null,
    `Marks ${sourceName} as merged, so links to the record open ${targetName}.`,
    "Closes any booking review the merge settles.",
  ].filter((step) => step !== null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!merging) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-lg" showCloseButton={!merging}>
        <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3.5">
          <DialogTitle className="text-[17px] font-semibold text-balance">
            Merge <span translate="no">{sourceName}</span> into <span translate="no">{targetName}</span>?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-danger-ink">This can&apos;t be undone.</DialogDescription>
        </DialogHeader>

        <dl className="border-b py-1">
          <Fact label="Absorbed">
            <PersonFact name={sourceName} email={source.lead.email} />
          </Fact>
          <Fact label="Kept">
            <PersonFact name={targetName} email={target.lead.email} />
          </Fact>
          <Fact label="Moves">{moves.join(" · ")}</Fact>
        </dl>

        <div className="pt-2.5">
          <p className={`${LABEL} px-4 pb-1.5`}>What happens</p>
          <ol className="text-[13px] leading-[1.45]">
            {steps.map((step, index) => (
              <li key={index} className="flex gap-2.5 border-t px-4 py-[7px]">
                <span className="w-3 shrink-0 font-condensed text-[14px] font-semibold text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={merging}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={merging} className="font-semibold">
            {merging ? <Spinner data-icon="inline-start" /> : null}
            {merging ? "Merging…" : "Merge people"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PersonFact({ name, email }: { name: string; email: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2" translate="no">
      <span className="font-medium break-words">{name}</span>
      {email && email !== name ? <span className="min-w-0 truncate text-[13px] text-muted-foreground">{email}</span> : null}
    </span>
  );
}

/** One dense fact: a slate label column beside the value, about 32px. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}
