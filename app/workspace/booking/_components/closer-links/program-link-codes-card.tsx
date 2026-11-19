"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LINK_CODE_MAX_LENGTH } from "@/convex/lib/closerLinks";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import posthog from "@/lib/posthog-browser";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { cardButton, PortalCard, PortalRow } from "../portal/portal-card";

type ProgramRow = FunctionReturnType<typeof api.bookingSetup.closerLinks.listCloserLinks>["programs"][number];

const INPUT =
  "h-8 w-full min-w-0 rounded-[7px] border border-input bg-card px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-primary-ink focus-visible:ring-3 focus-visible:ring-primary-ink/20";

/** The code each active program adds to closer links as utm_content. */
export function ProgramLinkCodesCard({ programs }: { programs: ProgramRow[] }) {
  const setProgramLinkCode = useMutation(api.tenantPrograms.mutations.setProgramLinkCode);
  const [editing, setEditing] = useState<Id<"tenantPrograms"> | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function startEdit(program: ProgramRow) {
    setEditing(program.programId);
    setDraft(program.linkCode ?? "");
  }

  async function save(event: React.FormEvent, program: ProgramRow) {
    event.preventDefault();
    const code = draft.trim();
    if (!code) return;
    setSaving(true);
    try {
      const saved = await setProgramLinkCode({ programId: program.programId, linkCode: code });
      posthog.capture("program_link_code_set", { replaced: program.linkCode !== null });
      toast.success(`${program.name} uses ${saved}`);
      setEditing(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the code"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalCard id="card-program-codes" title="Program link codes" meta="Sent as utm_content">
      {programs.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">No active programs.</p>
      ) : (
        <ul aria-label="Program link codes">
          {programs.map((program) => {
            const open = editing === program.programId;
            return (
              <li key={program.programId} className="border-b border-border last:border-b-0">
                <PortalRow className="border-b-0">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{program.name}</span>
                  {program.linkCode ? (
                    <code
                      translate="no"
                      className="max-w-[140px] truncate rounded-[5px] border border-border bg-background px-1.5 py-[2px] font-mono text-[12px]"
                    >
                      {program.linkCode}
                    </code>
                  ) : null}
                  <button
                    type="button"
                    className={cardButton({ size: "sm" })}
                    aria-expanded={open}
                    onClick={() => (open ? setEditing(null) : startEdit(program))}
                  >
                    {program.linkCode ? "Edit" : "Add code"}
                  </button>
                </PortalRow>
                {open ? (
                  <form
                    onSubmit={(event) => void save(event, program)}
                    className="cov-row-in flex flex-col gap-2 border-t border-border bg-background px-4 py-2.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        aria-label={`Link code for ${program.name}`}
                        placeholder="e.g. accelerator"
                        value={draft}
                        maxLength={LINK_CODE_MAX_LENGTH}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
                        className={cn(INPUT, "flex-1")}
                        translate="no"
                      />
                      <button type="button" className={cardButton({ size: "sm" })} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className={cardButton({ size: "sm", tone: "ink" })}
                        disabled={saving || !draft.trim()}
                      >
                        {saving ? <Spinner className="size-3" /> : null}
                        <TranslatableText>Save</TranslatableText>
                      </button>
                    </div>
                    <p className="text-[12px] text-muted-foreground">
                      Lowercase letters, numbers and dashes.
                      {program.linkCode
                        ? " Changing a code means links already sent with the old code book without a program."
                        : null}
                    </p>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PortalCard>
  );
}
