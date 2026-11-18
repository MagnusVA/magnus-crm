"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ClockAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { useNow } from "@/hooks/use-now";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  SEVERE_WRONG_FIELDS,
  WRONG_FIELD_LABELS,
  ageWords,
  kindDefinition,
  type WrongField,
} from "./automation-kinds";
import { panelCommandSentence } from "./automation-command-words";
import { INLINE_FIGURE, SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import { PersonName, RecordLinks } from "./record-links";

type AuditCase = FunctionReturnType<typeof api.automation.audit.listAuditQueue>["cases"][number];
type Verdict = "correct" | "wrong";

const REASON_WORDS: Record<AuditCase["reason"], string> = {
  canary: "One of the first 10, all checked",
  sampled: "Sampled, one in five",
};

/**
 * Automatic writes waiting for a person's check, soonest deadline first.
 * The queue pages through the automatic writes 50 at a time, so "Look
 * further back" reads the next page. An overdue check is said in words.
 * With `show` false (no kind at Automatic) the card hides while nothing waits.
 */
export function AuditCard({ show }: { show: boolean }) {
  const id = useId();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const first = useQuery(api.automation.audit.listAuditQueue, {});
  const empty = first !== undefined && first.cases.length === 0 && first.nextCursor === null && cursors.length === 1;
  if (!show && (first === undefined || empty)) return null;
  if (empty) {
    return (
      <section aria-labelledby={`${id}-title`} className={CARD}>
        <CardHead title={<span id={`${id}-title`}>Checks of automatic results</span>} />
        <SectionEmpty title="Nothing is waiting for a check.">
          The first 10 results a kind records by itself are all checked, then one in five.
        </SectionEmpty>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "@container/audit")}>
      <CardHead
        title={<span id={`${id}-title`}>Checks of automatic results</span>}
        meta="A check left past its deadline sends the kind back to one tap."
      />
      {first === undefined ? (
        <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">Loading the checks…</p>
      ) : (
        cursors.map((cursor, index) => (
          <AuditPage
            key={cursor ?? "first"}
            cursor={cursor}
            last={index === cursors.length - 1}
            onMore={(next) => setCursors((current) => [...current, next])}
          />
        ))
      )}
    </section>
  );
}

function AuditPage({
  cursor,
  last,
  onMore,
}: {
  cursor: string | undefined;
  last: boolean;
  onMore: (cursor: string) => void;
}) {
  const page = useQuery(api.automation.audit.listAuditQueue, cursor ? { cursor } : {});
  if (page === undefined) {
    return <p role="status" className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>;
  }
  return (
    <>
      <ul>
        {page.cases.map((entry) => (
          <li key={entry.decisionId} className="border-t border-border">
            <AuditRow entry={entry} />
          </li>
        ))}
      </ul>
      {last && page.nextCursor ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-2.5">
          <NoteLine className="mr-auto">Older automatic writes may also be waiting.</NoteLine>
          <Button type="button" size="sm" variant="outline" onClick={() => onMore(page.nextCursor as string)}>
            Look further back
          </Button>
        </div>
      ) : null}
    </>
  );
}

function AuditRow({ entry }: { entry: AuditCase }) {
  const now = useNow();
  const definition = kindDefinition(entry.kind);
  const overdue = entry.dueAt <= now;
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className="font-semibold">{definition.shortName}</span>
        <span className="text-muted-foreground">·</span>
        <PersonName leadId={entry.leadId} />
        <span className="text-muted-foreground">· {REASON_WORDS[entry.reason]}</span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {definition.recordedWords}, <span className="tabular-nums">{dayTimeFormat.format(entry.writtenAt)}</span>.
      </p>
      {overdue ? (
        <p className="flex items-start gap-1.5 text-[13px] font-medium text-warning-ink">
          <ClockAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Overdue: the check was due <span className="tabular-nums">{dayTimeFormat.format(entry.dueAt)}</span>,{" "}
            {ageWords(entry.dueAt, now)} ago. This kind asks for a tap until it is checked.
          </span>
        </p>
      ) : (
        <p className="text-[13px]">
          Check by <span className={INLINE_FIGURE}>{dayTimeFormat.format(entry.dueAt)}</span>
          <span className="text-muted-foreground"> · {ageWords(now, entry.dueAt)} left</span>
        </p>
      )}
      <RecordLinks
        opportunityId={entry.opportunityId}
        meetingId={entry.meetingId}
        providerPaymentId={entry.providerPaymentId}
      />
      <AuditVerdictForm entry={entry} fields={definition.wrongFields} />
    </div>
  );
}

function AuditVerdictForm({ entry, fields }: { entry: AuditCase; fields: readonly WrongField[] }) {
  const recordAudit = useMutation(api.automation.audit.recordAudit);
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [wrong, setWrong] = useState<WrongField[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const needsFields = verdict === "wrong" && wrong.length === 0;
  const severe = verdict === "wrong" && wrong.some((field) => SEVERE_WRONG_FIELDS.includes(field));

  const save = async () => {
    if (!verdict || needsFields) return;
    setPending(true);
    setError(null);
    try {
      const result = await recordAudit({
        decisionId: entry.decisionId,
        verdict,
        wrongFields: verdict === "wrong" ? wrong : [],
      });
      if (!result.ok) {
        setError(panelCommandSentence(result.code));
        return;
      }
      toast.success("Check saved.");
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the check."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p id={labelId} className="text-[13px] font-semibold">Is this result right?</p>
        <ToggleGroup
          type="single"
          value={verdict}
          aria-labelledby={labelId}
          className={SEGMENT_GROUP}
          onValueChange={(next) => setVerdict((next as Verdict) || "")}
        >
          <ToggleGroupItem value="correct" className={SEGMENT}>Correct</ToggleGroupItem>
          <ToggleGroupItem value="wrong" className={SEGMENT}>Wrong</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {verdict === "wrong" ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] text-muted-foreground">What was wrong? Tick each one.</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {fields.map((field) => (
              <label key={field} className="flex min-h-6 items-center gap-2 text-sm">
                <Checkbox
                  checked={wrong.includes(field)}
                  onCheckedChange={(checked) =>
                    setWrong((current) =>
                      checked === true ? [...current, field] : current.filter((value) => value !== field),
                    )
                  }
                />
                {WRONG_FIELD_LABELS[field]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {severe ? (
        <NoteLine tone="warning">
          Saving this sends the kind back to one tap. Put the result itself right from the deal, the meeting or the payment.
        </NoteLine>
      ) : verdict === "wrong" && wrong.length ? (
        <NoteLine>
          The result stays as it is. Put it right from the deal, the meeting or the payment.
          {wrong.some((field) => field === "amount" || field === "type" || field === "program")
            ? " A wrong amount, type or program also sends that product's mapping back to one tap."
            : null}
        </NoteLine>
      ) : null}
      {error ? <NoteLine tone="danger" role="alert">{error}</NoteLine> : null}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
        {needsFields ? <p className="mr-auto text-[13px] text-muted-foreground">Tick what was wrong.</p> : null}
        <Button type="button" size="sm" disabled={!verdict || needsFields || pending} onClick={() => void save()}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{pending ? "Saving…" : "Save check"}</TranslatableText>
        </Button>
      </div>
    </div>
  );
}
